// The tables of the media built-in plugin (Plan 77 step 6). The core
// schema builds them in its fixed order; only this plugin's code names them.
// Product media: image records whose bytes live in R2 under their SHA-256,
// and each product's ordered list. product_media_item answers "is this image
// shown anywhere" without reading every list.
// Product media: image records whose bytes live in R2 under their SHA-256,
// and each product's ordered list. product_media_item answers "is this image
// shown anywhere" without reading every list.
export const MEDIA_SCHEMA = `
CREATE TABLE IF NOT EXISTS media (
  merchant_id TEXT NOT NULL,
  media_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  media_json TEXT NOT NULL CHECK (json_valid(media_json)),
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, media_id)
) STRICT;
CREATE INDEX IF NOT EXISTS media_sha256 ON media (merchant_id, sha256);
CREATE TABLE IF NOT EXISTS product_media (
  merchant_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  media_json TEXT NOT NULL CHECK (json_valid(media_json)),
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, product_id)
) STRICT;
CREATE TABLE IF NOT EXISTS product_media_item (
  merchant_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  media_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (merchant_id, product_id, media_id),
  FOREIGN KEY (merchant_id, media_id)
    REFERENCES media (merchant_id, media_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX IF NOT EXISTS product_media_item_media
  ON product_media_item (merchant_id, media_id);`;
