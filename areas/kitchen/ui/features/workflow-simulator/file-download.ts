export function downloadBakeryFile(
  name: string,
  text: string | Blob,
  mimeType = "application/json",
): void {
  const url = URL.createObjectURL(new Blob([text], { type: mimeType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(URL.revokeObjectURL, 1000, url);
}
