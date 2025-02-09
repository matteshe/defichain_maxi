import { MainNet } from '@defichain/jellyfish-network'
import { LoanVaultActive, LoanVaultState } from '@defichain/whale-api-client/dist/api/loan'
import { VaultMaxiProgram, VaultMaxiProgramTransaction } from './programs/vault-maxi-program'
import { Store } from './utils/store'
import { Telegram } from './utils/telegram'
import { WalletSetup } from './utils/wallet-setup'
import { CommonProgram, ProgramState } from './programs/common-program'
import { ProgramStateConverter } from './utils/program-state-converter'
import { delay, isNullOrEmpty, nextCollateralRatio, nextCollateralValue, nextLoanValue } from './utils/helpers'
import { BigNumber } from "@defichain/jellyfish-api-core";
import { WhaleClientTimeoutException } from '@defichain/whale-api-client'

class SettingsOverride {
    minCollateralRatio: number | undefined
    maxCollateralRatio: number | undefined
    LMToken: string | undefined
    LMPair: string | undefined
    mainCollateralAsset: string | undefined
    ignoreSkip: boolean = false
}

class maxiEvent {
    overrideSettings: SettingsOverride | undefined
    checkSetup: boolean | undefined
}

const MIN_TIME_PER_ACTION_MS = 300 * 1000 //min 5 minutes for action. probably only needs 1-2, but safety first?

export const VERSION = "v2.2"
export const DONATION_ADDRESS = "df1qqtlz4uw9w5s4pupwgucv4shl6atqw7xlz2wn07"
export const DONATION_MAX_PERCENTAGE = 50

export async function main(event: maxiEvent, context: any): Promise<Object> {
    console.log("vault maxi " + VERSION)
    let blockHeight = 0
    let cleanUpFailed= false
    let ocean = process.env.VAULTMAXI_OCEAN_URL
    let errorCooldown= 60000
    while (context.getRemainingTimeInMillis() >= MIN_TIME_PER_ACTION_MS) {
        console.log("starting with " + context.getRemainingTimeInMillis() + "ms available")
        let store = new Store()
        let settings = await store.fetchSettings()
        console.log("initial state: " + ProgramStateConverter.toValue(settings.stateInformation))

        const logId = process.env.VAULTMAXI_LOGID ? (" " + process.env.VAULTMAXI_LOGID) : ""
        const telegram = new Telegram(settings, "[Maxi" + settings.paramPostFix + " " + VERSION + logId + "]")
        

        let commonProgram: CommonProgram | undefined
        try {
            if (settings.shouldSkipNext) {
                //reset to false, so no double skip ever
                console.log("got skip command, reset to false")
                await store.clearSkip()                
            }
            if (event) {
                console.log("received event " + JSON.stringify(event))
                if (event.overrideSettings) {
                    if (event.overrideSettings.maxCollateralRatio)
                        settings.maxCollateralRatio = event.overrideSettings.maxCollateralRatio
                    if (event.overrideSettings.minCollateralRatio)
                        settings.minCollateralRatio = event.overrideSettings.minCollateralRatio
                    if (event.overrideSettings.LMToken)
                        settings.LMPair = event.overrideSettings.LMToken + "-DUSD"
                    if (event.overrideSettings.LMPair)
                        settings.LMPair = event.overrideSettings.LMPair
                    if (event.overrideSettings.mainCollateralAsset)
                        settings.mainCollateralAsset = event.overrideSettings.mainCollateralAsset
                    if (event.overrideSettings.ignoreSkip && settings.shouldSkipNext) {
                        settings.shouldSkipNext = false
                        await store.skipNext()
                    }
                }
            }
            if (settings.shouldSkipNext) {
                //inform EVERYONE to not miss it in case of an error.
                const message = "skipped one execution as requested"
                console.log(message)
                await telegram.send(message)
                await telegram.log(message)
                return { statusCode: 200 }
            }
            const program = new VaultMaxiProgram(store, new WalletSetup(MainNet, settings, ocean))
            commonProgram = program
            await program.init()
            blockHeight= await program.getBlockHeight()
            console.log("starting at block "+blockHeight)
            if (event) {
                if (event.checkSetup) {
                    let result = await program.doAndReportCheck(telegram)
                    return { statusCode: result ? 200 : 500 }
                }
            }
            const vaultcheck = await program.getVault()
            let pool = await program.getPool(program.lmPair)
            let balances = await program.getTokenBalances()
            if (!await program.doMaxiChecks(telegram, vaultcheck, pool, balances)) {
                return { statusCode: 500 }
            }

            let result = true
            let vault: LoanVaultActive = vaultcheck as LoanVaultActive //already checked before if all is fine

            //TODO: move that block to function in programm
            // 2022-03-08 Krysh: Something went wrong on last execution, we need to clean up, whatever was done
            if (settings.stateInformation.state !== ProgramState.Idle) {
                const information = settings.stateInformation
                console.log("last execution stopped state " + information.state)
                console.log(" at tx " + information.tx)
                console.log(" with txId " + information.txId)
                console.log(" on block height " + information.blockHeight)

                // 2022-03-09 Krysh: input of kuegi
                // if we are on state waiting for last transaction,  we should wait for txId
                if (information.state === ProgramState.WaitingForTransaction || information.txId.length > 0) {
                    console.log("waiting for tx from previous run")
                    const resultFromPrevTx = await program.waitForTx(information.txId, information.blockHeight)
                    vault = await program.getVault() as LoanVaultActive
                    balances = await program.getTokenBalances()
                    pool = await program.getPool(program.lmPair)
                    console.log(resultFromPrevTx ? "done" : " timed out -> cleanup")
                    if (!resultFromPrevTx || VaultMaxiProgram.shouldCleanUpBasedOn(information.tx as VaultMaxiProgramTransaction)) {
                        information.state = ProgramState.Error //force cleanup
                    } else if (information.state === ProgramState.WaitingForTransaction) {
                        information.state = ProgramState.Idle
                    }
                    await program.updateToState(information.state, VaultMaxiProgramTransaction.None)
                }
                // 2022-03-09 Krysh: only clean up if it is really needed, otherwise we are fine and can proceed like normally
                if (information.state === ProgramState.Error) {
                    let safetyMode: boolean = cleanUpFailed
                    console.log("need to clean up " + (safetyMode ? "in safety mode due to previous error" : ""))
                    cleanUpFailed = true //will be set to false if success
                    result = await program.cleanUp(vault, balances, telegram, safetyMode)
                    vault = await program.getVault() as LoanVaultActive
                    balances = await program.getTokenBalances()
                    pool = await program.getPool(program.lmPair)
                    //need to get updated vault
                    await telegram.log("executed clean-up part of script " + (result ? "successfully" : "with problems") + ". vault ratio after clean-up " + vault.collateralRatio)
                    if (!result) { //probably a timeout
                        console.error("Error in cleaning up, trying again in safetyMode")
                        await telegram.send("There was an error in recovering from a failed state. please check yourself!")
                        if (context.getRemainingTimeInMillis() > MIN_TIME_PER_ACTION_MS) {
                            result = await program.cleanUp(vault, balances, telegram, true)
                            vault = await program.getVault() as LoanVaultActive
                            balances = await program.getTokenBalances()
                            pool = await program.getPool(program.lmPair)
                        }
                    } else {
                        console.log("cleanup done")
                        await telegram.send("Successfully cleaned up after some error happened")
                    }
                    cleanUpFailed = !result
                    //If safety mode, try another cleanup afterwards to clean the whole adress in case of temporary error
                    await program.updateToState(safetyMode ? ProgramState.Error : ProgramState.Idle, VaultMaxiProgramTransaction.None)
                    console.log("got " + (context.getRemainingTimeInMillis() / 1000).toFixed(1) + " sec left after cleanup")
                    if (context.getRemainingTimeInMillis() < MIN_TIME_PER_ACTION_MS) {
                        return { statusCode: result ? 200 : 500 } //not enough time left, better quit and have a clean run on next invocation
                    }

                }
            }

            if (vault.state == LoanVaultState.FROZEN) {
                await program.removeExposure(vault, pool!, balances, telegram, true)
                const message = "vault is frozen. trying again later "
                await telegram.send(message)
                console.warn(message)
                return { statusCode: 200 }
            }

            //if DUSD loan is involved and current interest rate on DUSD is above LM rewards -> remove Exposure
            if (settings.mainCollateralAsset === "DFI") {
                const poolApr = (pool?.apr?.total ?? 0) * 100
                const dusdToken = await program.getLoanToken("15")
                let interest = +vault.loanScheme.interestRate + +dusdToken.interest
                console.log("DUSD currently has a total interest of " + interest.toFixed(4) + " = " + vault.loanScheme.interestRate + " + " + dusdToken.interest + " vs APR of " + poolApr.toFixed(4))
                if (interest > poolApr) {
                    console.log("interest rate higher than APR -> removing exposure")
                    await telegram.send("interest rate higher than APR -> removing/preventing exposure")
                    settings.maxCollateralRatio = -1
                }
            }

            const oldRatio = +vault.collateralRatio
            const nextRatio = nextCollateralRatio(vault)
            const usedCollateralRatio = BigNumber.min(vault.collateralRatio, nextRatio)
            console.log("starting with " + vault.collateralRatio + " (next: " + nextRatio + ") in vault, target "
                + settings.minCollateralRatio + " - " + settings.maxCollateralRatio
                + " (" + (program.targetRatio() * 100) + ") pair " + settings.LMPair
                + ", " + (program.isSingle() ? ("minting only " + program.assetA) : "minting both"))
            let exposureChanged = false
            
            //first check for removeExposure, then decreaseExposure
            // if no decrease necessary: check for reinvest (as a reinvest would probably trigger an increase exposure, do reinvest first)
            // no reinvest (or reinvest done and still time left) -> check for increase exposure
            if (settings.maxCollateralRatio <= 0) {
                if (usedCollateralRatio.gt(0)) {
                    result = await program.removeExposure(vault, pool!, balances, telegram)
                    exposureChanged = true
                    vault = await program.getVault() as LoanVaultActive
                    balances = await program.getTokenBalances()
                }
            } else if (usedCollateralRatio.gt(0) && usedCollateralRatio.lt(settings.minCollateralRatio)) {
                result = await program.decreaseExposure(vault, pool!, telegram)
                exposureChanged = true
                vault = await program.getVault() as LoanVaultActive
                balances = await program.getTokenBalances()
            } else {
                result = true
                exposureChanged = await program.checkAndDoReinvest(vault, pool!, balances, telegram)
                console.log("got " + (context.getRemainingTimeInMillis() / 1000).toFixed(1) + " sec left after reinvest")
                if (exposureChanged) {
                    vault = await program.getVault() as LoanVaultActive
                    balances = await program.getTokenBalances()
                }
                if (context.getRemainingTimeInMillis() > MIN_TIME_PER_ACTION_MS) {// enough time left -> continue
                    const usedCollateralRatio = BigNumber.min(+vault.collateralRatio, nextCollateralRatio(vault))
                    if (+vault.collateralValue < 10) {
                        const message = "less than 10 dollar in the vault. can't work like that"
                        await telegram.send(message)
                        console.error(message)
                    } else if (usedCollateralRatio.lt(0) || usedCollateralRatio.gt(settings.maxCollateralRatio)) {
                        result = await program.increaseExposure(vault, pool!, balances, telegram)
                        exposureChanged = true
                        vault = await program.getVault() as LoanVaultActive
                        balances = await program.getTokenBalances()
                    }
                }
                if (context.getRemainingTimeInMillis() > MIN_TIME_PER_ACTION_MS && settings.stableCoinArbBatchSize > 0) {// enough time left -> continue
                    const freeCollateral = BigNumber.min(+vault.collateralValue - (+vault.loanValue * (+vault.loanScheme.minColRatio / 100 + 0.01)),
                        nextCollateralValue(vault).minus(nextLoanValue(vault).times(+vault.loanScheme.minColRatio / 100 + 0.01)))
                    let batchSize = settings.stableCoinArbBatchSize
                    if (freeCollateral.lt(settings.stableCoinArbBatchSize)) {
                        const message = "available collateral from ratio (" + freeCollateral.toFixed(1) + ") is less than batchsize for Arb, please adjust"
                        await telegram.send(message)
                        console.warn(message)
                        batchSize = freeCollateral.toNumber()
                    }
                    if (batchSize > 0) {
                        const changed = await program.checkAndDoStableArb(vault, pool!, batchSize, telegram)
                        exposureChanged = exposureChanged || changed
                        if(changed) {
                            vault = await program.getVault() as LoanVaultActive
                            balances = await program.getTokenBalances()
                        }
                    }
                }
            }

            await program.updateToState(result ? ProgramState.Idle : ProgramState.Error, VaultMaxiProgramTransaction.None)
            console.log("wrote state")
            const safetyLevel = await program.calcSafetyLevel(vault, pool!, balances)
            let message = "executed script at block "+ blockHeight+" "
            if (exposureChanged) {
                message += (result ? "successfully" : "with problems")
                    + ".\nvault ratio changed from " + oldRatio + " (next " + nextRatio + ") to "
                    + vault.collateralRatio + " (next " + nextCollateralRatio(vault) +
                    ")."
            } else {
                message += "without changes.\nvault ratio " + oldRatio + " next " + nextRatio + "."
            }
            message += "\ntarget range " + settings.minCollateralRatio + " - " + settings.maxCollateralRatio
                + "\ncurrent safetylevel: " + safetyLevel.toFixed(0) + "%"
            await telegram.log(message)
            console.log("script done, safety level: " + safetyLevel.toFixed(0))
            return { statusCode: result ? 200 : 500 }
        } catch (e) {
            console.error("Error in script")
            console.error(e)
            let message = "There was an unexpected error in the script. please check the logs"
            if (e instanceof SyntaxError) {
                console.info("syntaxError: '"+e.name+"' message: "+e.message)
                if(e.message == "Unexpected token < in JSON at position 0" ) {
                    message = "There was a error from the ocean api. will try again."
                }
                //TODO: do we have to go to error state in this case? or just continue on current state next time?
            }
            if (e instanceof WhaleClientTimeoutException ) {
                message = "There was a timeout from the ocean api. will try again."
                //TODO: do we have to go to error state in this case? or just continue on current state next time?
            }
            if (!isNullOrEmpty(telegram.chatId) && !isNullOrEmpty(telegram.token)) {
                await telegram.send(message)
            } else {
                await telegram.log(message)
            }
            if (ocean != undefined) {
                console.info("falling back to default ocean")
                ocean = undefined
            }
            //program might not be there, so directly the store with no access to ocean
            await store.updateToState({
                state: ProgramState.Error,
                tx: "",
                txId: commonProgram?.pendingTx ?? "",
                blockHeight: blockHeight,
                version: VERSION
            })
            await delay(errorCooldown) // cooldown and not to spam telegram
            errorCooldown += 60000 //increase cooldown. if error is serious -> less spam in telegram
        }
    }
    return { statusCode: 500 } //means we came out of error loop due to not enough time left
}
