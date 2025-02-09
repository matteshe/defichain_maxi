import fetch from "cross-fetch";
import { StoredSettings } from "./store";
import { Message } from "./telegram";

export interface Poolpair {
    symbol: string
}

export const oceanURL = process.env.VAULTMAXI_OCEAN_URL ?? "https://ocean.defichain.com"

export function isNullOrEmpty(value: string): boolean {
    return value === undefined || value.length === 0
}

export function checkSafetyOf(message: Message, settings: StoredSettings): boolean {
    let lastExecutedMessageId = settings.lastExecutedMessageId ?? 0
    return message.id > lastExecutedMessageId && // only execute new messages
            message.username === settings.username && // only messages of the configured user
            message.chat_id === settings.chatId && // only from configured chat
            !message.is_bot // message should not come from a bot
}

export function functionNameWithPostfix(): string {
    let postfix = process.env.VAULTMAXI_STORE_POSTFIX ?? process.env.VAULTMAXI_STORE_POSTIX ?? ""
    return "defichain-vault-maxi" + postfix
}

export function isNumber(value: string|undefined): boolean {
    if (value === undefined) {
        return false
    }
    return !isNaN(Number(value))
}

export function extendForListOfPoolPairs(url: string): string {
    return url + "/v0/mainnet/poolpairs?size=1000"
}

export async function fetchListOfPoolPairs(): Promise<string[]> {
    const response = await fetch(extendForListOfPoolPairs(oceanURL))
    const json = await response.json()
    let poolpairs = json["data"] as Poolpair[]
    return poolpairs.map((poolpair) => {
        return poolpair.symbol.replace("-DUSD", "")
    })
}