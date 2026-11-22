// The ports of the trial Workers (Refactor 17). The platform Worker registers
// its ports when its entry module loads, and the Session Durable Object class
// registers the Session turn rule (`actors/agent-session.ts`). A trial Worker
// loads neither, so it registers both here, with the production
// implementations, before it serves a request.
import "../../services/platform/src/worker-ports.ts";
import { authorizeChatHarnessLease } from "../../services/platform/src/chat/turn-access.ts";
import { registerSessionTurnAccess } from "../../foundation/agent/actors/session-turn-access.ts";

registerSessionTurnAccess(authorizeChatHarnessLease);
