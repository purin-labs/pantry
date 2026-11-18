export type AccessControlAvailability =
  "available" | "needs_attention" | "unavailable";

export type AccessControlBoundedPage<T> = Readonly<{
  items: readonly T[];
  nextCursor: string | null;
}>;

export type FileResourceDiscoveryEntry =
  | Readonly<{
      readonly kind: "dropbox_folder";
      readonly providerFolderId: string;
      readonly name: string;
      readonly pathDisplay: string;
    }>
  | Readonly<{
      readonly kind: "dropbox_file";
      readonly providerFileId: string;
      readonly name: string;
      readonly pathDisplay: string;
    }>;
