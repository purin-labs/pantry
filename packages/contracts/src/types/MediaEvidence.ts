import type { MediaDeclaringProvider } from "./MediaDeclaringProvider";
import type { MediaSignatureMethod } from "./MediaSignatureMethod";

/**
 * A media type together with the evidence that established it.
 *
 * Parameterizing by the branch's media type keeps the evidence and the class
 * in one value, so an image branch cannot hold video evidence. A provider
 * declaration is never recorded as byte-verified; code that requires verified
 * bytes matches exhaustively and refuses anything weaker.
 */
export type MediaEvidence<TMediaType> =
  | {
      kind: "signature_verified";
      mediaType: TMediaType;
      method: MediaSignatureMethod;
    }
  | {
      kind: "provider_declared";
      mediaType: TMediaType;
      provider: MediaDeclaringProvider;
    };
