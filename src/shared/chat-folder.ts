/**
 * The folder Hello keeps for a chat that has none of the person's: where a
 * PDF or a workbook dropped on the chat lands, where the tools work on it and
 * where what they make is left, until the person saves it where they want it.
 * It is attached like any folder, so every tool works there as it does in one
 * the person chose — and it is told from one by its path alone.
 */
export const CHAT_FOLDER_NAME = 'Chat files';
const OWN = /[\\/]chat-files[\\/][0-9a-f]{64}[\\/]Chat files[\\/]?$/;
/** Whether a chat's folder is the one Hello keeps for it. Main compares the exact path; this is for what only sees the path. */
export const isChatFolderPath = (folder: string | null | undefined): boolean => typeof folder === 'string' && OWN.test(folder);
