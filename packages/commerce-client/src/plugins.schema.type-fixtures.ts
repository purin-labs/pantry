// Plan 78 step 2: each client type equals its schema type.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;
import type * as apiPlugins from "@purin-labs/commerce-contracts/records/api-plugins";
import type {
  CommercePluginSettingValueV1,
  CommercePluginSettingsV1,
  CommercePluginAttributeV1,
  CommercePluginActionInputV1,
  ConfigureCommercePluginV1,
  InstallCommerceMerchantPluginV1,
  PauseCommercePluginV1,
  PreviewCommerceMerchantPluginV1,
  CommercePluginChangeV1,
  PreviewCommercePluginChangeV1,
  RemoveCommercePluginV1,
  ResumeCommercePluginV1,
  RunCommercePluginActionV1,
  RunCommercePluginFunctionV1,
  SetCommercePluginFieldValuesV1,
  CommerceMerchantPluginPreviewV1,
  CommercePluginActionV1,
  CommercePluginCommandCheckV1,
  CommercePluginCommandV1,
  CommercePluginEffectV1,
  CommercePluginEntityTypeV1,
  CommercePluginFailureV1,
  CommercePluginFieldV1,
  CommercePluginFieldValuesV1,
  CommercePluginFieldValueListV1,
  CommercePluginFunctionRunV1,
  CommercePluginHandlerV1,
  CommercePluginV1,
  CommercePluginListV1,
  CommercePluginPreviewV1,
} from "./plugins.ts";
export type CommercePluginSettingValueV1Parity = Assert<
  Equal<
    CommercePluginSettingValueV1,
    apiPlugins.CommercePluginSettingValueV1
  >
>;
export type CommercePluginSettingsV1Parity = Assert<
  Equal<CommercePluginSettingsV1, apiPlugins.CommercePluginSettingsV1>
>;
export type CommercePluginAttributeV1Parity = Assert<
  Equal<CommercePluginAttributeV1, apiPlugins.CommercePluginAttributeV1>
>;
export type CommercePluginActionInputV1Parity = Assert<
  Equal<CommercePluginActionInputV1, apiPlugins.CommercePluginActionInputV1>
>;
export type InstallCommerceMerchantPluginV1Parity = Assert<
  Equal<
    InstallCommerceMerchantPluginV1,
    apiPlugins.InstallCommerceMerchantPluginV1
  >
>;
export type ConfigureCommercePluginV1Parity = Assert<
  Equal<ConfigureCommercePluginV1, apiPlugins.ConfigureCommercePluginV1>
>;
export type PauseCommercePluginV1Parity = Assert<
  Equal<PauseCommercePluginV1, apiPlugins.PauseCommercePluginV1>
>;
export type PreviewCommerceMerchantPluginV1Parity = Assert<
  Equal<
    PreviewCommerceMerchantPluginV1,
    apiPlugins.PreviewCommerceMerchantPluginV1
  >
>;
export type CommercePluginChangeV1Parity = Assert<
  Equal<CommercePluginChangeV1, apiPlugins.CommercePluginChangeV1>
>;
export type PreviewCommercePluginChangeV1Parity = Assert<
  Equal<
    PreviewCommercePluginChangeV1,
    apiPlugins.PreviewCommercePluginChangeV1
  >
>;
export type RemoveCommercePluginV1Parity = Assert<
  Equal<RemoveCommercePluginV1, apiPlugins.RemoveCommercePluginV1>
>;
export type ResumeCommercePluginV1Parity = Assert<
  Equal<ResumeCommercePluginV1, apiPlugins.ResumeCommercePluginV1>
>;
export type RunCommercePluginActionV1Parity = Assert<
  Equal<RunCommercePluginActionV1, apiPlugins.RunCommercePluginActionV1>
>;
export type RunCommercePluginFunctionV1Parity = Assert<
  Equal<RunCommercePluginFunctionV1, apiPlugins.RunCommercePluginFunctionV1>
>;
export type SetCommercePluginFieldValuesV1Parity = Assert<
  Equal<
    SetCommercePluginFieldValuesV1,
    apiPlugins.SetCommercePluginFieldValuesV1
  >
>;
export type CommerceMerchantPluginPreviewV1Parity = Assert<
  Equal<
    CommerceMerchantPluginPreviewV1,
    apiPlugins.CommerceMerchantPluginPreviewV1
  >
>;
export type CommercePluginActionV1Parity = Assert<
  Equal<CommercePluginActionV1, apiPlugins.CommercePluginActionV1>
>;
export type CommercePluginCommandCheckV1Parity = Assert<
  Equal<
    CommercePluginCommandCheckV1,
    apiPlugins.CommercePluginCommandCheckV1
  >
>;
export type CommercePluginCommandV1Parity = Assert<
  Equal<CommercePluginCommandV1, apiPlugins.CommercePluginCommandV1>
>;
export type CommercePluginEffectV1Parity = Assert<
  Equal<CommercePluginEffectV1, apiPlugins.CommercePluginEffectV1>
>;
export type CommercePluginEntityTypeV1Parity = Assert<
  Equal<CommercePluginEntityTypeV1, apiPlugins.CommercePluginEntityTypeV1>
>;
export type CommercePluginFailureV1Parity = Assert<
  Equal<CommercePluginFailureV1, apiPlugins.CommercePluginFailureV1>
>;
export type CommercePluginFieldV1Parity = Assert<
  Equal<CommercePluginFieldV1, apiPlugins.CommercePluginFieldV1>
>;
export type CommercePluginFieldValuesV1Parity = Assert<
  Equal<CommercePluginFieldValuesV1, apiPlugins.CommercePluginFieldValuesV1>
>;
export type CommercePluginFieldValueListV1Parity = Assert<
  Equal<
    CommercePluginFieldValueListV1,
    apiPlugins.CommercePluginFieldValueListV1
  >
>;
export type CommercePluginFunctionRunV1Parity = Assert<
  Equal<CommercePluginFunctionRunV1, apiPlugins.CommercePluginFunctionRunV1>
>;
export type CommercePluginHandlerV1Parity = Assert<
  Equal<CommercePluginHandlerV1, apiPlugins.CommercePluginHandlerV1>
>;
export type CommercePluginV1Parity = Assert<
  Equal<CommercePluginV1, apiPlugins.CommercePluginV1>
>;
export type CommercePluginListV1Parity = Assert<
  Equal<CommercePluginListV1, apiPlugins.CommercePluginListV1>
>;
export type CommercePluginPreviewV1Parity = Assert<
  Equal<CommercePluginPreviewV1, apiPlugins.CommercePluginPreviewV1>
>;
