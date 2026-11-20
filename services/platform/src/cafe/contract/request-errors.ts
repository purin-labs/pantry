import { ToolRequestError } from "../../agent-tools/errors";

/** A menu request that the model can correct. Its message reaches the model. */
export class MenuDraftRequestError extends ToolRequestError {}

/**
 * A board or menu price request that the model can correct. Its message
 * reaches the model, as a menu draft refusal does.
 */
export class MenuBoardRequestError extends MenuDraftRequestError {}
