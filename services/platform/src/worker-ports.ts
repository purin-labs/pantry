// The Worker registers each port of a lower module here, once, when its
// entry module loads (Refactor 17). A port reads its implementation at the
// call, so each part names its function when it runs.
import { listVerifiedContactEndpoints } from "./data/contact-verification";
import { proposeEvalFromCorrection } from "./evals/access";
import { verifiedContacts } from "./mail-inbox/contract/verified-contacts";
import {
  createTurnMemoryReader,
  proposeMemoryFromCorrection,
  readMemoryViews,
  readShownMemoryStanding,
} from "./memory/access";
import { memoryService } from "./memory/contract/memory-service";

memoryService.register({
  readMemoryViews: (...input) => readMemoryViews(...input),
  readShownMemoryStanding: (...input) => readShownMemoryStanding(...input),
  createTurnMemoryReader: (...input) => createTurnMemoryReader(...input),
  proposeMemoryFromCorrection: (...input) =>
    proposeMemoryFromCorrection(...input),
  proposeEvalFromCorrection: (...input) => proposeEvalFromCorrection(...input),
});

verifiedContacts.register({
  listVerifiedContactEndpoints: (...input) =>
    listVerifiedContactEndpoints(...input),
});
