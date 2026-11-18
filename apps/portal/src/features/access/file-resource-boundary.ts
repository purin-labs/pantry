import type { GoogleDrivePickedFile } from "@seams/control-api/portal/access-models";
import { bounded, record } from "@seams/control-api/portal/file-resources";

export type GooglePickerCallbackRuntime = Readonly<{
  Action: Readonly<{ PICKED: string; CANCEL: string; ERROR: string }>;
  Response: Readonly<{ ACTION: string; DOCUMENTS: string }>;
  Document: Readonly<{ ID: string; NAME: string }>;
}>;

export function settleGoogleDrivePicker(
  picker: GooglePickerCallbackRuntime,
  resolve: (file: GoogleDrivePickedFile | null) => void,
  reject: (reason: Error) => void,
  raw: unknown,
): void {
  try {
    const data = record(raw, "Google Drive Picker result");
    const action = data[picker.Response.ACTION];
    if (action === picker.Action.CANCEL) {
      resolve(null);
      return;
    }
    if (action === picker.Action.ERROR) {
      reject(new Error("Google Drive Picker failed."));
      return;
    }
    if (action !== picker.Action.PICKED) return;
    const documents = data[picker.Response.DOCUMENTS];
    if (!Array.isArray(documents) || documents.length !== 1) {
      throw new Error("Choose exactly one Google Drive file.");
    }
    const document = record(documents[0], "Google Drive picked file");
    const providerFileId = document[picker.Document.ID];
    const name = document[picker.Document.NAME];
    if (!bounded(providerFileId, 512) || !bounded(name, 512)) {
      throw new Error("Google Drive picked-file identity is invalid.");
    }
    resolve({ providerFileId, name });
  } catch (error) {
    reject(
      error instanceof Error ? error : new Error("Google Drive Picker failed."),
    );
  }
}
