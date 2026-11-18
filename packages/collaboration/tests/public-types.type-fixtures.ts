import {
  RelativeTextSelection,
  type ParsedYjsEncoding,
  type YjsEncodingResult,
} from "../src/index";

export function rejectRawAndMixedEncodings(
  state: ParsedYjsEncoding<"state">,
  update: ParsedYjsEncoding<"update">,
): void {
  // @ts-expect-error State and update encodings have distinct identities.
  const wrongKind: ParsedYjsEncoding<"update"> = state;
  // @ts-expect-error Private bytes prevent structural construction.
  const forged: ParsedYjsEncoding<"update"> = { kind: "update", encode: bytes };
  const accepted: YjsEncodingResult<ParsedYjsEncoding<"update">> = { ok: true, value: update };
  const rejected: YjsEncodingResult<ParsedYjsEncoding<"update">> = {
    ok: false,
    error: { code: "invalid_update" },
  };
  // @ts-expect-error Success cannot carry failure state through a broad spread.
  const mixedSuccess: YjsEncodingResult<ParsedYjsEncoding<"update">> = { ...accepted, error: rejected.error };
  // @ts-expect-error Failure cannot carry an accepted update through a broad spread.
  const mixedFailure: YjsEncodingResult<ParsedYjsEncoding<"update">> = { ...rejected, value: update };
  void wrongKind;
  void forged;
  void mixedSuccess;
  void mixedFailure;
}

export function rejectSelectionConstruction(): void {
  // @ts-expect-error Relative selections must be captured from a Y.Text.
  new RelativeTextSelection();
}

function bytes(): Uint8Array {
  return new Uint8Array();
}
