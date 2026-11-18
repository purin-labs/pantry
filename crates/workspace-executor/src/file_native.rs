//! Strict boundary for the first one-product file-native workspace.
//!
//! Activation manifests can only be produced by signing a validated draft:
//!
//! ```compile_fail
//! use workspace_executor::file_native::CatalogActivationManifestV1;
//!
//! let _invalid = CatalogActivationManifestV1 {
//!     schema_version: "satyr.catalog-activation.v1".to_string(),
//!     organisation_id: todo!(),
//!     merchant_id: todo!(),
//!     release_id: todo!(),
//!     release_hash: todo!(),
//!     base_catalog_revision: todo!(),
//!     created_at: todo!(),
//!     catalog: todo!(),
//!     approval: todo!(),
//!     signer: todo!(),
//! };
//! ```

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

use crate::contracts::{
    ActorId, CommerceTimestamp, CurrencyCode, IdempotencyKey, IdentityError, Money, OrganisationId,
    PolicyVersion, ResourceId, Sha256Digest, WorkspaceId, WorkspaceRevision, valid_identity_text,
};

pub const WORKSPACE_SCHEMA_V1: &str = "satyr.workspace.v1";
pub const PRODUCT_SCHEMA_V1: &str = "satyr.product.v1";
pub const VARIANTS_SCHEMA_V1: &str = "satyr.variants.v1";
pub const ACTIVATION_SCHEMA_V1: &str = "satyr.catalog-activation.v1";
pub const PRODUCT_FOLDER_CHANGESET_SCHEMA_V1: &str = "satyr.product-folder-changeset.v1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileNativeError {
    Io { path: String, reason: String },
    InvalidYaml { path: String, reason: String },
    InvalidFrontmatter,
    InvalidIdentity { field: String },
    InvalidText { field: String },
    InvalidVariantSet,
    ManagedIdentityMismatch { field: String },
    UnsupportedSchema { expected: String, received: String },
    UnsafePath { path: String },
    SignatureFailed { reason: String },
    Serialization { reason: String },
    InvalidChangesetCandidate,
}

macro_rules! bounded_identity {
    ($name:ident) => {
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn parse(value: impl Into<String>) -> Result<Self, FileNativeError> {
                let value = value.into();
                if !valid_identity_text(&value) {
                    return Err(FileNativeError::InvalidIdentity {
                        field: stringify!($name).to_string(),
                    });
                }
                Ok(Self(value))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }
    };
}

bounded_identity!(MerchantId);
bounded_identity!(CatalogRevision);
bounded_identity!(ApprovalReceiptId);
bounded_identity!(SigningKeyId);
bounded_identity!(Signature);

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct ReleaseId(String);

impl ReleaseId {
    fn from_digest(digest: &Sha256Digest) -> Self {
        Self(format!("release_{}", digest.as_str()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductVariantV1 {
    variant_id: ResourceId,
    sku: String,
    title: String,
    price: Money,
}

impl ProductVariantV1 {
    pub fn variant_id(&self) -> &ResourceId {
        &self.variant_id
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductDocumentV1 {
    product_id: ResourceId,
    slug: String,
    title: String,
    description: String,
    currency: CurrencyCode,
    variants: Vec<ProductVariantV1>,
}

impl ProductDocumentV1 {
    pub fn product_id(&self) -> &ResourceId {
        &self.product_id
    }

    pub fn variants(&self) -> &[ProductVariantV1] {
        &self.variants
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductFolderV1 {
    organisation_id: OrganisationId,
    workspace_id: WorkspaceId,
    product: ProductDocumentV1,
}

impl ProductFolderV1 {
    pub fn parse(root: impl AsRef<Path>) -> Result<Self, FileNativeError> {
        parse_product_folder(root.as_ref())
    }

    pub fn organisation_id(&self) -> &OrganisationId {
        &self.organisation_id
    }

    pub fn workspace_id(&self) -> &WorkspaceId {
        &self.workspace_id
    }

    pub fn product(&self) -> &ProductDocumentV1 {
        &self.product
    }

    pub fn semantic_hash(&self) -> Result<String, FileNativeError> {
        sha256_json(self)
    }

    pub fn render(&self, root: impl AsRef<Path>) -> Result<(), FileNativeError> {
        render_product_folder(self, root.as_ref())
    }

    pub fn semantic_diff(&self, next: &Self) -> Result<ProductFolderDiffV1, FileNativeError> {
        require_same_identity(self, next)?;

        let mut fields = BTreeSet::new();
        if self.product.slug != next.product.slug {
            fields.insert(ProductFieldV1::Slug);
        }
        if self.product.title != next.product.title {
            fields.insert(ProductFieldV1::Title);
        }
        if self.product.description != next.product.description {
            fields.insert(ProductFieldV1::Description);
        }
        if self.product.currency != next.product.currency {
            fields.insert(ProductFieldV1::Currency);
        }

        let before = variants_by_id(&self.product.variants);
        let after = variants_by_id(&next.product.variants);
        let variant_ids = before
            .keys()
            .copied()
            .chain(after.keys().copied())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .filter(|id| before.get(id) != after.get(id))
            .cloned()
            .collect();

        Ok(ProductFolderDiffV1 {
            product_id: self.product.product_id.clone(),
            fields: fields.into_iter().collect(),
            variant_ids,
        })
    }

    pub fn validated_changeset(
        &self,
        next: &Self,
        base_revision: WorkspaceRevision,
    ) -> Result<ValidatedProductFolderChangesetV1, FileNativeError> {
        let diff = self.semantic_diff(next)?;
        let resulting_semantic_hash = Sha256Digest::parse(next.semantic_hash()?)?;
        let digest_material = ProductFolderChangesetDigestMaterialV1 {
            schema_version: PRODUCT_FOLDER_CHANGESET_SCHEMA_V1,
            organisation_id: &self.organisation_id,
            workspace_id: &self.workspace_id,
            base_revision: &base_revision,
            resulting_semantic_hash: &resulting_semantic_hash,
            diff: &diff,
        };
        let changeset_digest = Sha256Digest::parse(sha256_json(&digest_material)?)?;

        Ok(ValidatedProductFolderChangesetV1 {
            schema_version: PRODUCT_FOLDER_CHANGESET_SCHEMA_V1.to_string(),
            organisation_id: self.organisation_id.clone(),
            workspace_id: self.workspace_id.clone(),
            base_revision,
            resulting_semantic_hash,
            diff,
            changeset_digest,
        })
    }

    pub fn validate_changeset_candidate(
        &self,
        next: &Self,
        base_revision: WorkspaceRevision,
        claimed: &serde_json::Value,
    ) -> Result<ValidatedProductFolderChangesetV1, FileNativeError> {
        let derived = self.validated_changeset(next, base_revision)?;
        let derived_value =
            serde_json::to_value(&derived).map_err(|error| FileNativeError::Serialization {
                reason: error.to_string(),
            })?;
        if derived_value != *claimed {
            return Err(FileNativeError::InvalidChangesetCandidate);
        }
        Ok(derived)
    }

    pub fn to_catalog_product(&self) -> ProductDocumentV1 {
        self.product.clone()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProductFieldV1 {
    Slug,
    Title,
    Description,
    Currency,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductFolderDiffV1 {
    pub product_id: ResourceId,
    pub fields: Vec<ProductFieldV1>,
    pub variant_ids: Vec<ResourceId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidatedProductFolderChangesetV1 {
    pub schema_version: String,
    pub organisation_id: OrganisationId,
    pub workspace_id: WorkspaceId,
    pub base_revision: WorkspaceRevision,
    pub resulting_semantic_hash: Sha256Digest,
    pub diff: ProductFolderDiffV1,
    pub changeset_digest: Sha256Digest,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProductFolderChangesetDigestMaterialV1<'a> {
    schema_version: &'static str,
    organisation_id: &'a OrganisationId,
    workspace_id: &'a WorkspaceId,
    base_revision: &'a WorkspaceRevision,
    resulting_semantic_hash: &'a Sha256Digest,
    diff: &'a ProductFolderDiffV1,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogOfferRefV1 {
    pub offer_id: ResourceId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogMediaReferenceV1 {
    pub media_id: ResourceId,
    pub digest: Sha256Digest,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogPayloadV1 {
    digest: Sha256Digest,
    products: Vec<ProductDocumentV1>,
    offers: Vec<CatalogOfferRefV1>,
    media_references: Vec<CatalogMediaReferenceV1>,
}

impl CatalogPayloadV1 {
    pub fn digest(&self) -> &Sha256Digest {
        &self.digest
    }

    pub fn products(&self) -> &[ProductDocumentV1] {
        &self.products
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalV1 {
    receipt_id: ApprovalReceiptId,
    policy_version: PolicyVersion,
    approved_by: ActorRefV1,
    approved_at: CommerceTimestamp,
}

impl ApprovalV1 {
    pub fn new(
        receipt_id: ApprovalReceiptId,
        policy_version: PolicyVersion,
        approved_by: ActorRefV1,
        approved_at: CommerceTimestamp,
    ) -> Self {
        Self {
            receipt_id,
            policy_version,
            approved_by,
            approved_at,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ActorRefV1 {
    Human {
        user_id: ActorId,
    },
    Agent {
        agent_id: ActorId,
        session_id: ActorId,
    },
    Application {
        application_id: ActorId,
        installation_id: ActorId,
    },
    System {
        component: ActorId,
        operation: ActorId,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SignatureAlgorithmV1 {
    Ed25519,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignerDescriptorV1 {
    pub key_id: SigningKeyId,
    pub algorithm: SignatureAlgorithmV1,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestSignerV1 {
    key_id: SigningKeyId,
    algorithm: SignatureAlgorithmV1,
    signature: Signature,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogActivationManifestV1 {
    schema_version: String,
    organisation_id: OrganisationId,
    merchant_id: MerchantId,
    release_id: ReleaseId,
    release_hash: Sha256Digest,
    base_catalog_revision: CatalogRevision,
    created_at: CommerceTimestamp,
    catalog: CatalogPayloadV1,
    approval: ApprovalV1,
    signer: ManifestSignerV1,
}

impl CatalogActivationManifestV1 {
    pub fn release_id(&self) -> &ReleaseId {
        &self.release_id
    }

    pub fn release_hash(&self) -> &Sha256Digest {
        &self.release_hash
    }

    pub fn catalog(&self) -> &CatalogPayloadV1 {
        &self.catalog
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogActivationDraftV1 {
    organisation_id: OrganisationId,
    merchant_id: MerchantId,
    base_catalog_revision: CatalogRevision,
    created_at: CommerceTimestamp,
    catalog: CatalogPayloadV1,
    approval: ApprovalV1,
    signer: SignerDescriptorV1,
}

pub trait ReleaseSigner {
    fn descriptor(&self) -> SignerDescriptorV1;
    fn sign(&self, payload: &[u8]) -> Result<Signature, FileNativeError>;
}

impl CatalogActivationDraftV1 {
    pub fn new(
        folder: &ProductFolderV1,
        merchant_id: MerchantId,
        base_catalog_revision: CatalogRevision,
        created_at: CommerceTimestamp,
        approval: ApprovalV1,
        signer: SignerDescriptorV1,
    ) -> Result<Self, FileNativeError> {
        let products = vec![folder.to_catalog_product()];
        let digest = Sha256Digest::parse(sha256_json(&products)?)?;
        Ok(Self {
            organisation_id: folder.organisation_id.clone(),
            merchant_id,
            base_catalog_revision,
            created_at,
            catalog: CatalogPayloadV1 {
                digest,
                products,
                offers: Vec::new(),
                media_references: Vec::new(),
            },
            approval,
            signer,
        })
    }

    pub fn sign(
        self,
        signer: &impl ReleaseSigner,
    ) -> Result<CatalogActivationManifestV1, FileNativeError> {
        let descriptor = signer.descriptor();
        if descriptor != self.signer {
            return Err(FileNativeError::ManagedIdentityMismatch {
                field: "signer".to_string(),
            });
        }

        let release_hash = Sha256Digest::parse(sha256_json(&ReleaseHashPayloadV1::from(&self))?)?;
        let release_id = ReleaseId::from_digest(&release_hash);
        let signature_payload = SignaturePayloadV1 {
            release_hash: release_hash.as_str(),
            merchant_id: &self.merchant_id,
            base_catalog_revision: &self.base_catalog_revision,
            approval_receipt_id: &self.approval.receipt_id,
        };
        let signature = signer.sign(&canonical_json_bytes(&signature_payload)?)?;

        Ok(CatalogActivationManifestV1 {
            schema_version: ACTIVATION_SCHEMA_V1.to_string(),
            organisation_id: self.organisation_id,
            merchant_id: self.merchant_id,
            release_id,
            release_hash,
            base_catalog_revision: self.base_catalog_revision,
            created_at: self.created_at,
            catalog: self.catalog,
            approval: self.approval,
            signer: ManifestSignerV1 {
                key_id: descriptor.key_id,
                algorithm: descriptor.algorithm,
                signature,
            },
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivateCatalogReleaseV1 {
    manifest: CatalogActivationManifestV1,
    idempotency_key: IdempotencyKey,
    requested_by: ActorRefV1,
    requested_at: CommerceTimestamp,
}

impl ActivateCatalogReleaseV1 {
    pub fn new(
        manifest: CatalogActivationManifestV1,
        idempotency_key: IdempotencyKey,
        requested_by: ActorRefV1,
        requested_at: CommerceTimestamp,
    ) -> Self {
        Self {
            manifest,
            idempotency_key,
            requested_by,
            requested_at,
        }
    }

    pub fn manifest(&self) -> &CatalogActivationManifestV1 {
        &self.manifest
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReleaseHashPayloadV1<'a> {
    schema_version: &'static str,
    organisation_id: &'a OrganisationId,
    merchant_id: &'a MerchantId,
    base_catalog_revision: &'a CatalogRevision,
    created_at: &'a CommerceTimestamp,
    catalog: &'a CatalogPayloadV1,
    approval: &'a ApprovalV1,
    signer: &'a SignerDescriptorV1,
}

impl<'a> From<&'a CatalogActivationDraftV1> for ReleaseHashPayloadV1<'a> {
    fn from(value: &'a CatalogActivationDraftV1) -> Self {
        Self {
            schema_version: ACTIVATION_SCHEMA_V1,
            organisation_id: &value.organisation_id,
            merchant_id: &value.merchant_id,
            base_catalog_revision: &value.base_catalog_revision,
            created_at: &value.created_at,
            catalog: &value.catalog,
            approval: &value.approval,
            signer: &value.signer,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SignaturePayloadV1<'a> {
    release_hash: &'a str,
    merchant_id: &'a MerchantId,
    base_catalog_revision: &'a CatalogRevision,
    approval_receipt_id: &'a ApprovalReceiptId,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawWorkspaceV1 {
    schema_version: String,
    organisation_id: String,
    workspace_id: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawProductFrontmatterV1 {
    schema_version: String,
    product_id: String,
    slug: String,
    title: String,
    currency: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawVariantsFileV1 {
    schema_version: String,
    variants: Vec<RawVariantV1>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawVariantV1 {
    variant_id: String,
    sku: String,
    title: String,
    price_minor: i64,
}

fn parse_product_folder(root: &Path) -> Result<ProductFolderV1, FileNativeError> {
    require_directory(root)?;
    let workspace_path = root.join("workspace.yaml");
    let products_path = root.join("products");
    let workspace: RawWorkspaceV1 = parse_yaml_file(&workspace_path)?;
    require_schema(&workspace.schema_version, WORKSPACE_SCHEMA_V1)?;
    let organisation_id =
        OrganisationId::new(workspace.organisation_id).map_err(map_commerce_error)?;
    let workspace_id = WorkspaceId::parse(workspace.workspace_id)?;

    require_directory(&products_path)?;
    let product_directories = directory_entries(&products_path)?;
    if product_directories.len() != 1 {
        return Err(FileNativeError::InvalidVariantSet);
    }

    let product_root = &product_directories[0];
    require_directory(product_root)?;
    let product_markdown = read_regular_file(&product_root.join("product.md"))?;
    let (frontmatter, description) = split_frontmatter(&product_markdown)?;
    let product_raw: RawProductFrontmatterV1 =
        parse_yaml(&frontmatter, &product_root.join("product.md"))?;
    require_schema(&product_raw.schema_version, PRODUCT_SCHEMA_V1)?;
    if product_root.file_name().and_then(|value| value.to_str()) != Some(&product_raw.product_id) {
        return Err(FileNativeError::ManagedIdentityMismatch {
            field: "product directory".to_string(),
        });
    }

    let variants_raw: RawVariantsFileV1 = parse_yaml_file(&product_root.join("variants.yaml"))?;
    require_schema(&variants_raw.schema_version, VARIANTS_SCHEMA_V1)?;
    if variants_raw.variants.is_empty() {
        return Err(FileNativeError::InvalidVariantSet);
    }

    let currency = CurrencyCode::new(product_raw.currency).map_err(map_commerce_error)?;
    let mut variants = variants_raw
        .variants
        .into_iter()
        .map(|variant| parse_variant(variant, currency.as_str()))
        .collect::<Result<Vec<_>, _>>()?;
    variants.sort_by(|left, right| left.variant_id.as_str().cmp(right.variant_id.as_str()));
    require_unique_variant_ids(&variants)?;

    Ok(ProductFolderV1 {
        organisation_id,
        workspace_id,
        product: ProductDocumentV1 {
            product_id: ResourceId::new(product_raw.product_id).map_err(map_commerce_error)?,
            slug: require_text(product_raw.slug, "product.slug")?,
            title: require_text(product_raw.title, "product.title")?,
            description: require_multiline_text(&description, "product.description")?,
            currency,
            variants,
        },
    })
}

fn parse_variant(value: RawVariantV1, currency: &str) -> Result<ProductVariantV1, FileNativeError> {
    Ok(ProductVariantV1 {
        variant_id: ResourceId::new(value.variant_id).map_err(map_commerce_error)?,
        sku: require_text(value.sku, "variant.sku")?,
        title: require_text(value.title, "variant.title")?,
        price: Money::new(value.price_minor, currency)
            .and_then(Money::ensure_non_negative)
            .map_err(map_commerce_error)?,
    })
}

fn render_product_folder(value: &ProductFolderV1, root: &Path) -> Result<(), FileNativeError> {
    prepare_directory(root)?;
    let products_root = root.join("products");
    prepare_directory(&products_root)?;
    let product_root = products_root.join(value.product.product_id.as_str());
    prepare_directory(&product_root)?;

    let workspace = RawWorkspaceV1 {
        schema_version: WORKSPACE_SCHEMA_V1.to_string(),
        organisation_id: value.organisation_id.as_str().to_string(),
        workspace_id: value.workspace_id.as_str().to_string(),
    };
    write_regular_file(&root.join("workspace.yaml"), &render_yaml(&workspace)?)?;

    let frontmatter = RawProductFrontmatterV1 {
        schema_version: PRODUCT_SCHEMA_V1.to_string(),
        product_id: value.product.product_id.as_str().to_string(),
        slug: value.product.slug.clone(),
        title: value.product.title.clone(),
        currency: value.product.currency.as_str().to_string(),
    };
    let markdown = format!(
        "---\n{}---\n\n{}\n",
        render_yaml(&frontmatter)?,
        value.product.description
    );
    write_regular_file(&product_root.join("product.md"), &markdown)?;

    let variants = RawVariantsFileV1 {
        schema_version: VARIANTS_SCHEMA_V1.to_string(),
        variants: value
            .product
            .variants
            .iter()
            .map(|variant| RawVariantV1 {
                variant_id: variant.variant_id.as_str().to_string(),
                sku: variant.sku.clone(),
                title: variant.title.clone(),
                price_minor: variant.price.amount_minor(),
            })
            .collect(),
    };
    write_regular_file(
        &product_root.join("variants.yaml"),
        &render_yaml(&variants)?,
    )
}

fn require_same_identity(
    before: &ProductFolderV1,
    after: &ProductFolderV1,
) -> Result<(), FileNativeError> {
    if before.organisation_id != after.organisation_id {
        return Err(FileNativeError::ManagedIdentityMismatch {
            field: "organisationId".to_string(),
        });
    }
    if before.workspace_id != after.workspace_id {
        return Err(FileNativeError::ManagedIdentityMismatch {
            field: "workspaceId".to_string(),
        });
    }
    if before.product.product_id != after.product.product_id {
        return Err(FileNativeError::ManagedIdentityMismatch {
            field: "productId".to_string(),
        });
    }
    Ok(())
}

fn variants_by_id(values: &[ProductVariantV1]) -> BTreeMap<&ResourceId, &ProductVariantV1> {
    values
        .iter()
        .map(|variant| (&variant.variant_id, variant))
        .collect()
}

fn require_unique_variant_ids(values: &[ProductVariantV1]) -> Result<(), FileNativeError> {
    let ids = values
        .iter()
        .map(ProductVariantV1::variant_id)
        .collect::<BTreeSet<_>>();
    if ids.len() != values.len() {
        return Err(FileNativeError::InvalidVariantSet);
    }
    Ok(())
}

fn directory_entries(path: &Path) -> Result<Vec<PathBuf>, FileNativeError> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(path).map_err(|error| io_error(path, error))? {
        let entry = entry.map_err(|error| io_error(path, error))?;
        let entry_path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| io_error(&entry_path, error))?;
        if file_type.is_symlink() {
            return Err(FileNativeError::UnsafePath {
                path: entry_path.display().to_string(),
            });
        }
        if file_type.is_dir() {
            entries.push(entry_path);
        }
    }
    entries.sort();
    Ok(entries)
}

fn require_directory(path: &Path) -> Result<(), FileNativeError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| io_error(path, error))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(FileNativeError::UnsafePath {
            path: path.display().to_string(),
        });
    }
    Ok(())
}

fn prepare_directory(path: &Path) -> Result<(), FileNativeError> {
    if path.exists() {
        return require_directory(path);
    }
    fs::create_dir(path).map_err(|error| io_error(path, error))
}

fn read_regular_file(path: &Path) -> Result<String, FileNativeError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| io_error(path, error))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(FileNativeError::UnsafePath {
            path: path.display().to_string(),
        });
    }
    fs::read_to_string(path).map_err(|error| io_error(path, error))
}

fn write_regular_file(path: &Path, value: &str) -> Result<(), FileNativeError> {
    if path.exists() {
        let metadata = fs::symlink_metadata(path).map_err(|error| io_error(path, error))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(FileNativeError::UnsafePath {
                path: path.display().to_string(),
            });
        }
    }
    fs::write(path, normalize_text(value)).map_err(|error| io_error(path, error))
}

fn split_frontmatter(value: &str) -> Result<(String, String), FileNativeError> {
    let normalized = value.replace("\r\n", "\n");
    let rest = normalized
        .strip_prefix("---\n")
        .ok_or(FileNativeError::InvalidFrontmatter)?;
    let (frontmatter, body) = rest
        .split_once("\n---\n")
        .ok_or(FileNativeError::InvalidFrontmatter)?;
    Ok((frontmatter.to_string(), body.to_string()))
}

fn parse_yaml_file<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, FileNativeError> {
    parse_yaml(&read_regular_file(path)?, path)
}

fn parse_yaml<T: for<'de> Deserialize<'de>>(
    value: &str,
    path: &Path,
) -> Result<T, FileNativeError> {
    serde_yaml::from_str(value).map_err(|error| FileNativeError::InvalidYaml {
        path: path.display().to_string(),
        reason: error.to_string(),
    })
}

fn render_yaml(value: &impl Serialize) -> Result<String, FileNativeError> {
    serde_yaml::to_string(value)
        .map(|rendered| normalize_text(&rendered))
        .map_err(|error| FileNativeError::Serialization {
            reason: error.to_string(),
        })
}

fn require_schema(received: &str, expected: &str) -> Result<(), FileNativeError> {
    if received != expected {
        return Err(FileNativeError::UnsupportedSchema {
            expected: expected.to_string(),
            received: received.to_string(),
        });
    }
    Ok(())
}

fn require_text(value: String, field: &str) -> Result<String, FileNativeError> {
    let normalized = normalize_text(&value);
    if normalized.trim().is_empty() || normalized != normalized.trim() {
        return Err(FileNativeError::InvalidText {
            field: field.to_string(),
        });
    }
    Ok(normalized)
}

fn require_multiline_text(value: &str, field: &str) -> Result<String, FileNativeError> {
    let normalized = normalize_text(value);
    let trimmed = normalized.trim();
    if trimmed.is_empty() {
        return Err(FileNativeError::InvalidText {
            field: field.to_string(),
        });
    }
    Ok(trimmed.to_string())
}

fn normalize_text(value: &str) -> String {
    value.replace("\r\n", "\n").nfc().collect()
}

fn sha256_json(value: &impl Serialize) -> Result<String, FileNativeError> {
    Ok(hex_digest(&canonical_json_bytes(value)?))
}

fn canonical_json_bytes(value: &impl Serialize) -> Result<Vec<u8>, FileNativeError> {
    serde_json::to_vec(value).map_err(|error| FileNativeError::Serialization {
        reason: error.to_string(),
    })
}

fn hex_digest(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}

fn map_commerce_error(error: impl std::fmt::Debug) -> FileNativeError {
    FileNativeError::InvalidText {
        field: format!("{error:?}"),
    }
}

fn io_error(path: &Path, error: std::io::Error) -> FileNativeError {
    FileNativeError::Io {
        path: path.display().to_string(),
        reason: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use super::*;

    struct TestSigner;

    impl ReleaseSigner for TestSigner {
        fn descriptor(&self) -> SignerDescriptorV1 {
            SignerDescriptorV1 {
                key_id: SigningKeyId::parse("key_test").unwrap(),
                algorithm: SignatureAlgorithmV1::Ed25519,
            }
        }

        fn sign(&self, payload: &[u8]) -> Result<Signature, FileNativeError> {
            Signature::parse(format!("test_{}", hex_digest(payload)))
        }
    }

    #[test]
    fn parse_render_parse_preserves_semantic_hash() {
        let source = fixture_path();
        let parsed = ProductFolderV1::parse(&source).unwrap();
        let output = temporary_path("roundtrip");
        parsed.render(&output).unwrap();
        let reparsed = ProductFolderV1::parse(&output).unwrap();

        assert_eq!(
            parsed.semantic_hash().unwrap(),
            reparsed.semantic_hash().unwrap()
        );
        fs::remove_dir_all(output).unwrap();
    }

    #[test]
    fn semantic_diff_rejects_managed_identity_changes() {
        let source = fixture_path();
        let before = ProductFolderV1::parse(&source).unwrap();
        let output = temporary_path("identity");
        copy_fixture(&source, &output);
        let workspace_path = output.join("workspace.yaml");
        let changed = fs::read_to_string(&workspace_path)
            .unwrap()
            .replace("organisation_demo", "organisation_other");
        fs::write(&workspace_path, changed).unwrap();
        let after = ProductFolderV1::parse(&output).unwrap();

        assert_eq!(
            before.semantic_diff(&after),
            Err(FileNativeError::ManagedIdentityMismatch {
                field: "organisationId".to_string()
            })
        );
        fs::remove_dir_all(output).unwrap();
    }

    #[test]
    fn semantic_diff_reports_authored_field_and_variant_changes() {
        let source = fixture_path();
        let before = ProductFolderV1::parse(&source).unwrap();
        let output = temporary_path("diff");
        copy_fixture(&source, &output);
        let product_path = output.join("products/product_field_watch/product.md");
        let product = fs::read_to_string(&product_path)
            .unwrap()
            .replace("title: Field Watch", "title: Field Watch II");
        fs::write(product_path, product).unwrap();
        let variants_path = output.join("products/product_field_watch/variants.yaml");
        let variants = fs::read_to_string(&variants_path).unwrap().replacen(
            "priceMinor: 42500",
            "priceMinor: 43000",
            1,
        );
        fs::write(variants_path, variants).unwrap();
        let after = ProductFolderV1::parse(&output).unwrap();
        let diff = before.semantic_diff(&after).unwrap();

        assert_eq!(diff.fields, vec![ProductFieldV1::Title]);
        assert_eq!(
            diff.variant_ids,
            vec![ResourceId::new("variant_field_watch_black").unwrap()]
        );
        fs::remove_dir_all(output).unwrap();
    }

    #[test]
    fn validated_changeset_is_derived_from_both_parsed_revisions() {
        let source = fixture_path();
        let before = ProductFolderV1::parse(&source).unwrap();
        let output = temporary_path("changeset");
        copy_fixture(&source, &output);
        let product_path = output.join("products/product_field_watch/product.md");
        let product = fs::read_to_string(&product_path)
            .unwrap()
            .replace("title: Field Watch", "title: Field Watch II");
        fs::write(product_path, product).unwrap();
        let after = ProductFolderV1::parse(&output).unwrap();
        let base_revision = WorkspaceRevision::parse("workspace_revision_7").unwrap();

        let first = before
            .validated_changeset(&after, base_revision.clone())
            .unwrap();
        let second = before.validated_changeset(&after, base_revision).unwrap();

        assert_eq!(first, second);
        assert_eq!(first.schema_version, PRODUCT_FOLDER_CHANGESET_SCHEMA_V1);
        assert_eq!(
            first.resulting_semantic_hash.as_str(),
            after.semantic_hash().unwrap()
        );
        assert_eq!(first.diff.fields, vec![ProductFieldV1::Title]);
        fs::remove_dir_all(output).unwrap();
    }

    #[test]
    fn executor_changeset_candidate_must_match_materialized_files() {
        let source = fixture_path();
        let before = ProductFolderV1::parse(&source).unwrap();
        let output = temporary_path("executor_candidate");
        copy_fixture(&source, &output);
        let product_path = output.join("products/product_field_watch/product.md");
        let product = fs::read_to_string(&product_path)
            .unwrap()
            .replace("title: Field Watch", "title: Field Watch II");
        fs::write(product_path, product).unwrap();
        let after = ProductFolderV1::parse(&output).unwrap();
        let base_revision = WorkspaceRevision::parse("workspace_revision_7").unwrap();
        let derived = before
            .validated_changeset(&after, base_revision.clone())
            .unwrap();
        let claimed = serde_json::to_value(&derived).unwrap();

        assert_eq!(
            before
                .validate_changeset_candidate(&after, base_revision.clone(), &claimed)
                .unwrap(),
            derived
        );

        let mut forged = claimed;
        forged["resultingSemanticHash"] = serde_json::Value::String(
            "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff".to_string(),
        );
        assert_eq!(
            before
                .validate_changeset_candidate(&after, base_revision, &forged)
                .unwrap_err(),
            FileNativeError::InvalidChangesetCandidate
        );
        fs::remove_dir_all(output).unwrap();
    }

    #[test]
    fn activation_release_identity_is_derived_and_deterministic() {
        let folder = ProductFolderV1::parse(fixture_path()).unwrap();
        let signer = TestSigner;
        let draft = activation_draft(&folder, signer.descriptor());
        let first = draft.clone().sign(&signer).unwrap();
        let second = draft.sign(&signer).unwrap();

        assert_eq!(first, second);
        assert_eq!(
            first.release_id().as_str(),
            format!("release_{}", first.release_hash().as_str())
        );
        assert_eq!(
            first.catalog().products()[0].product_id().as_str(),
            "product_field_watch"
        );
    }

    #[test]
    fn signer_mismatch_cannot_produce_a_manifest() {
        let folder = ProductFolderV1::parse(fixture_path()).unwrap();
        let draft = activation_draft(
            &folder,
            SignerDescriptorV1 {
                key_id: SigningKeyId::parse("key_other").unwrap(),
                algorithm: SignatureAlgorithmV1::Ed25519,
            },
        );

        assert_eq!(
            draft.sign(&TestSigner),
            Err(FileNativeError::ManagedIdentityMismatch {
                field: "signer".to_string()
            })
        );
    }

    #[test]
    fn catalog_activation_fixture_matches_the_rust_contract() {
        let folder = ProductFolderV1::parse(fixture_path()).unwrap();
        let signer = TestSigner;
        let command = ActivateCatalogReleaseV1::new(
            activation_draft(&folder, signer.descriptor())
                .sign(&signer)
                .unwrap(),
            IdempotencyKey::parse("activate_release_rust_fixture").unwrap(),
            ActorRefV1::Human {
                user_id: ActorId::parse("user_demo").unwrap(),
            },
            CommerceTimestamp::parse("2026-07-27T00:00:00Z").unwrap(),
        );
        let fixture = fs::read_to_string(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../packages/contracts/fixtures/catalog-activation-v1.json"),
        )
        .unwrap();
        let expected: serde_json::Value = serde_json::from_str(&fixture).unwrap();

        assert_eq!(serde_json::to_value(command).unwrap(), expected);
    }

    fn activation_draft(
        folder: &ProductFolderV1,
        signer: SignerDescriptorV1,
    ) -> CatalogActivationDraftV1 {
        CatalogActivationDraftV1::new(
            folder,
            MerchantId::parse("merchant_demo").unwrap(),
            CatalogRevision::parse("catalog_revision_7").unwrap(),
            CommerceTimestamp::parse("2026-07-27T00:00:00Z").unwrap(),
            ApprovalV1::new(
                ApprovalReceiptId::parse("approval_demo").unwrap(),
                PolicyVersion::parse("policy_1").unwrap(),
                ActorRefV1::Human {
                    user_id: ActorId::parse("user_demo").unwrap(),
                },
                CommerceTimestamp::parse("2026-07-27T00:00:00Z").unwrap(),
            ),
            signer,
        )
        .unwrap()
    }

    fn fixture_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/contracts/fixtures/product-folder-v1")
    }

    fn temporary_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("satyr-contracts-{label}-{}", std::process::id()))
    }

    fn copy_fixture(source: &Path, target: &Path) {
        fs::create_dir_all(target.join("products/product_field_watch")).unwrap();
        fs::copy(source.join("workspace.yaml"), target.join("workspace.yaml")).unwrap();
        for name in ["product.md", "variants.yaml"] {
            fs::copy(
                source.join("products/product_field_watch").join(name),
                target.join("products/product_field_watch").join(name),
            )
            .unwrap();
        }
    }
}

impl From<IdentityError> for FileNativeError {
    fn from(error: IdentityError) -> Self {
        match error {
            IdentityError::InvalidIdentity { field } => Self::InvalidIdentity { field },
        }
    }
}
