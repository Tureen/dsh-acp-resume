/**
 * The detail tab's resource address (D18): `dsh-resource://acp-resume-chat/<chatId>`.
 * The address is the tab's identity, so opening the same chat twice focuses the
 * tab already open, tabs of different chats are independent, and the layout the
 * sidebar persists is enough to restore them after a reload (navigation params
 * are not persisted).
 * @module dsh-acp-resume/client/chat-address
 */

/** Address prefix claimed by the detail tab type. */
export const CHAT_ADDRESS_PREFIX = 'dsh-resource://acp-resume-chat/'

/** Glob the tab type declares as `patterns`. */
export const CHAT_ADDRESS_PATTERN = `${CHAT_ADDRESS_PREFIX}**`

/**
 * @param chatId - pool chat id.
 * @returns the resource address that opens its detail tab.
 */
export function chatAddress(chatId: string): string {
  return `${CHAT_ADDRESS_PREFIX}${encodeURIComponent(chatId)}`
}

/**
 * @param address - any resource address.
 * @returns the chat id it names, or undefined for another or malformed address.
 */
export function parseChatAddress(address: string): string | undefined {
  if (!address.startsWith(CHAT_ADDRESS_PREFIX)) return undefined
  const rest = address.slice(CHAT_ADDRESS_PREFIX.length)
  if (rest === '' || rest.includes('/') || rest.includes('?') || rest.includes('#')) return undefined
  try {
    const chatId = decodeURIComponent(rest)
    return chatId === '' ? undefined : chatId
  } catch {
    return undefined
  }
}
