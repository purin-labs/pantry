/**
 * Byte-exact media fixtures.
 *
 * These are real containers, not placeholder bytes: the inspection path parses
 * them, so a fixture that merely looked plausible would prove nothing.
 */

export async function docxArchive(text: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const name = encoder.encode("word/document.xml");
  const raw = encoder.encode(
    `<w:document><w:body><w:p><w:t>${text}</w:t></w:p></w:body></w:document>`,
  );
  const local: number[] = [];
  const central: number[] = [];
  const u16 = (target: number[], value: number) => {
    target.push(value & 0xff, (value >> 8) & 0xff);
  };
  const u32 = (target: number[], value: number) => {
    target.push(
      value & 0xff,
      (value >> 8) & 0xff,
      (value >> 16) & 0xff,
      (value >>> 24) & 0xff,
    );
  };

  u32(local, 0x04034b50);
  u16(local, 20);
  u16(local, 0);
  u16(local, 0);
  u16(local, 0);
  u16(local, 0);
  u32(local, 0);
  u32(local, raw.byteLength);
  u32(local, raw.byteLength);
  u16(local, name.byteLength);
  u16(local, 0);
  local.push(...name, ...raw);

  u32(central, 0x02014b50);
  u16(central, 20);
  u16(central, 20);
  u16(central, 0);
  u16(central, 0);
  u16(central, 0);
  u16(central, 0);
  u32(central, 0);
  u32(central, raw.byteLength);
  u32(central, raw.byteLength);
  u16(central, name.byteLength);
  u16(central, 0);
  u16(central, 0);
  u16(central, 0);
  u16(central, 0);
  u32(central, 0);
  u32(central, 0);
  central.push(...name);

  const eocd: number[] = [];
  u32(eocd, 0x06054b50);
  u16(eocd, 0);
  u16(eocd, 0);
  u16(eocd, 1);
  u16(eocd, 1);
  u32(eocd, central.length);
  u32(eocd, local.length);
  u16(eocd, 0);

  return new Uint8Array([...local, ...central, ...eocd]);
}

export function h264Fixture(): Uint8Array {
  const box = (name: string, body: number[]): number[] => {
    const size = body.length + 8;
    return [
      (size >> 24) & 0xff,
      (size >> 16) & 0xff,
      (size >> 8) & 0xff,
      size & 0xff,
      ...Array.from(name, function code(character) {
        return character.charCodeAt(0);
      }),
      ...body,
    ];
  };
  const ascii = (value: string): number[] =>
    Array.from(value, function code(character) {
      return character.charCodeAt(0);
    });
  const u32 = (value: number): number[] => [
    (value >> 24) & 0xff,
    (value >> 16) & 0xff,
    (value >> 8) & 0xff,
    value & 0xff,
  ];

  const hdlr = [...new Array<number>(8).fill(0), ...ascii("vide")];
  const mdhd = [...new Array<number>(12).fill(0), ...u32(1), ...u32(3)];
  const stsd = [...new Array<number>(8).fill(0), ...u32(0), ...ascii("avc1")];
  const stts = [...u32(0), ...u32(1), ...u32(3), ...u32(1)];
  const stsz = [
    ...u32(0),
    ...u32(0),
    ...u32(3),
    ...u32(4),
    ...u32(4),
    ...u32(4),
  ];
  const stsc = [...u32(0), ...u32(1), ...u32(1), ...u32(3), ...u32(1)];
  const stco = [...u32(0), ...u32(1), ...u32(0)];
  const stbl = [
    ...box("stsd", stsd),
    ...box("stts", stts),
    ...box("stsz", stsz),
    ...box("stsc", stsc),
    ...box("stco", stco),
  ];
  const mdia = [
    ...box("mdhd", mdhd),
    ...box("hdlr", hdlr),
    ...box("minf", box("stbl", stbl)),
  ];
  const moov = box("trak", box("mdia", mdia));

  return new Uint8Array([
    ...box("ftyp", ascii("isom\u0000\u0000\u0000\u0000isom")),
    ...box("moov", moov),
  ]);
}

export function waveHeader(): Uint8Array {
  const bytes: number[] = [];
  const ascii = (value: string) => {
    for (const character of value) bytes.push(character.charCodeAt(0));
  };
  const u32 = (value: number) => {
    bytes.push(
      value & 0xff,
      (value >> 8) & 0xff,
      (value >> 16) & 0xff,
      (value >> 24) & 0xff,
    );
  };
  const u16 = (value: number) => {
    bytes.push(value & 0xff, (value >> 8) & 0xff);
  };

  ascii("RIFF");
  u32(0);
  ascii("WAVE");
  ascii("fmt ");
  u32(16);
  u16(1);
  u16(2);
  u32(44_100);
  u32(176_400);
  u16(4);
  u16(16);
  ascii("data");
  u32(352_800);

  return new Uint8Array(bytes);
}
