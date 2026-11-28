import { Select } from "@purin-labs/ui/select";
import {
  buildFinancierHandoffRecovery,
  type FinancierBakeOutcome,
  type FinancierBakeRecipeConfig,
  type FinancierHandoffRecoveryPreset,
} from "@purin-labs/production-simulation/recipes/financier-bake/model";
import type {
  FinancierBatterOutcome,
  FinancierBatterRecipeConfig,
} from "@purin-labs/production-simulation/recipes/financier-batter/model";
import type {
  FinancierPackOutcome,
  FinancierPackRecipeConfig,
} from "@purin-labs/production-simulation/recipes/financier-pack/model";
import type {
  CafeShiftOutcome,
  CafeShiftRecipeConfig,
} from "@purin-labs/production-simulation/recipes/cafe-shift/model";
import type { BlackSesameCobotRecipeConfig } from "@purin-labs/production-simulation/recipes/black-sesame/model";
import type { GingerTeaCobotRecipeConfig } from "@purin-labs/production-simulation/recipes/ginger-tea/model";
import type { LatteRecipeConfig } from "@purin-labs/production-simulation/recipes/latte/model";
import type { PastryBenchRecipeConfig } from "../production-run/pastry-bench/pastry-bench-model";
import { calibratedHandoffAssignments } from "./production-workspace-helpers";
import type { SiphonRecipeConfig } from "@purin-labs/production-simulation/recipes/siphon/model";
import { readOvenRunFile } from "../production-run/oven-recipe-file";
import {
  prepareOvenDefinition,
  type OvenRunSource,
} from "@purin-labs/production-simulation/runs/oven-run-file";
import { defaultAssignments } from "./production-draft";
import React from "react";
import {
  bakeryFingerprint,
  parseSettings,
} from "@purin-labs/bakery-model/bakery";
import {
  parseProductionScenario,
  productionDefinitionFingerprint,
} from "@purin-labs/bakery-model/bakery-production-scenario";
import { attachProductionScenario } from "@purin-labs/production-simulation/recipes/bakery/production-workcells";
import { compileProductionDraft } from "./production-draft";
import { saveProductionScenario } from "./production-scenario-api";
import { readProductionScenario } from "./production-scenario-api";
import { openPersistentWorkspaceRun } from "./shared-production-run";
import { controlRead } from "@purin-labs/control/portal/control-client";
import { readyProduction } from "./scheduled-rehearsal";
import { AUTHOR_ROUTES, renderItem } from "./production-workspace-choices";
import type { Variant } from "@purin-labs/type-utils";
import type { ProductionWorkspace } from "./production-workspace";
import {
  currentDraft,
  identityAfterSave,
  message,
  settingsMatch,
} from "./production-workspace-queries";

export const productionRecipeViews = {
  showOven(this: ProductionWorkspace, source: OvenRunSource): void {
    this.props.playback.pause();
    this.props.stopSimulation();
    this.props.persistentOvenVisible(true);
    this.scene.dispose();
    this.sceneMounted = false;
    this.setState({ oven: source });
  },

  async openSharedProduction(
    this: ProductionWorkspace,
    id: string,
  ): Promise<void> {
    const connection = this.props.connection;
    if (connection.kind !== "workspace")
      throw new Error("Open a workspace to read shared production runs.");
    const generation = ++this.generation;
    const source = await openPersistentWorkspaceRun(
      connection.organisationId,
      id,
      controlRead,
    );
    if (
      !this.mounted ||
      generation !== this.generation ||
      this.props.connection.kind !== "workspace" ||
      this.props.connection.organisationId !== connection.organisationId
    )
      return;
    this.showOven(source);
  },

  closeOven(this: ProductionWorkspace): void {
    this.props.persistentOvenVisible(false);
    this.setState({ oven: null });
  },

  showSiphon(this: ProductionWorkspace, recipe: SiphonRecipeConfig): void {
    this.props.playback.pause();
    this.props.stopSimulation();
    this.props.persistentOvenVisible(true);
    this.scene.dispose();
    this.sceneMounted = false;
    this.setState({ siphon: recipe });
  },

  closeSiphon(this: ProductionWorkspace): void {
    this.props.persistentOvenVisible(false);
    this.setState({ siphon: null });
  },

  showLatte(this: ProductionWorkspace, recipe: LatteRecipeConfig): void {
    this.props.playback.pause();
    this.props.stopSimulation();
    this.props.persistentOvenVisible(true);
    this.scene.dispose();
    this.sceneMounted = false;
    this.setState({ latte: recipe });
  },

  closeLatte(this: ProductionWorkspace): void {
    this.props.persistentOvenVisible(false);
    this.setState({ latte: null });
  },

  showBlackSesame(
    this: ProductionWorkspace,
    recipe: BlackSesameCobotRecipeConfig,
  ): void {
    this.props.playback.pause();
    this.props.stopSimulation();
    this.props.persistentOvenVisible(true);
    this.scene.dispose();
    this.sceneMounted = false;
    this.setState({ blackSesame: recipe });
  },

  closeBlackSesame(this: ProductionWorkspace): void {
    this.props.persistentOvenVisible(false);
    this.setState({ blackSesame: null });
  },

  showGingerTea(
    this: ProductionWorkspace,
    recipe: GingerTeaCobotRecipeConfig,
  ): void {
    this.props.playback.pause();
    this.props.stopSimulation();
    this.props.persistentOvenVisible(true);
    this.scene.dispose();
    this.sceneMounted = false;
    this.setState({ gingerTea: recipe });
  },

  closeGingerTea(this: ProductionWorkspace): void {
    this.props.persistentOvenVisible(false);
    this.setState({ gingerTea: null });
  },

  showFinancierBatter(
    this: ProductionWorkspace,
    recipe: FinancierBatterRecipeConfig,
  ): void {
    this.props.playback.pause();
    this.props.stopSimulation();
    this.props.persistentOvenVisible(true);
    this.scene.dispose();
    this.sceneMounted = false;
    this.setState({ financierBatter: recipe });
  },

  closeFinancierBatter(this: ProductionWorkspace): void {
    this.props.persistentOvenVisible(false);
    this.setState({ financierBatter: null });
  },

  showFinancierBake(
    this: ProductionWorkspace,
    recipe: FinancierBakeRecipeConfig,
  ): void {
    this.props.playback.pause();
    this.props.stopSimulation();
    this.props.persistentOvenVisible(true);
    this.scene.dispose();
    this.sceneMounted = false;
    this.setState({ financierBake: recipe });
  },

  closeFinancierBake(this: ProductionWorkspace): void {
    this.props.persistentOvenVisible(false);
    this.setState({ financierBake: null });
  },

  showFinancierPack(
    this: ProductionWorkspace,
    recipe: FinancierPackRecipeConfig,
  ): void {
    this.props.playback.pause();
    this.props.stopSimulation();
    this.props.persistentOvenVisible(true);
    this.scene.dispose();
    this.sceneMounted = false;
    this.setState({ financierPack: recipe });
  },

  closeFinancierPack(this: ProductionWorkspace): void {
    this.props.persistentOvenVisible(false);
    this.setState({ financierPack: null });
  },

  showPastryBench(
    this: ProductionWorkspace,
    recipe: PastryBenchRecipeConfig,
  ): void {
    this.props.playback.pause();
    this.props.stopSimulation();
    this.props.persistentOvenVisible(true);
    this.scene.dispose();
    this.sceneMounted = false;
    this.setState({ pastryBench: recipe });
  },

  closePastryBench(this: ProductionWorkspace): void {
    this.props.persistentOvenVisible(false);
    this.setState({ pastryBench: null });
  },

  showCafeShift(
    this: ProductionWorkspace,
    recipe: CafeShiftRecipeConfig,
  ): void {
    this.props.playback.pause();
    this.props.stopSimulation();
    this.props.persistentOvenVisible(true);
    this.scene.dispose();
    this.sceneMounted = false;
    this.setState({ cafeShift: recipe });
  },

  closeCafeShift(this: ProductionWorkspace): void {
    this.props.persistentOvenVisible(false);
    this.setState({ cafeShift: null });
  },

  applyCafeShiftToSchedule(
    this: ProductionWorkspace,
    outcome: Variant<CafeShiftOutcome, "completed">,
  ): void {
    const currentSettings =
      this.props.session.data.kind === "ready"
        ? this.props.session.data.plan.settings
        : this.props.settings;
    const batches = outcome.financierLoads;
    const bakers = outcome.staffing === "two-workers" ? 2 : 1;
    const piecesPerTray = Math.max(7, outcome.packedFinanciers);
    const parsed = parseSettings({
      ...currentSettings,
      batches,
      bakers,
      piecesPerTray,
    });
    this.props.persistentOvenVisible(false);
    this.setState({
      cafeShift: null,
      menuHistory: [
        {
          panel: "workflow",
          catalogOpen: false,
          catalogSection: null,
          activeBatchId: null,
          authorRoute: this.state.authorRoute,
        },
      ],
      catalogOpen: false,
      catalogSection: "active-production",
      activeBatchId: null,
      panelHidden: false,
      transitionDirection: "forward",
    });
    if (parsed.kind === "valid") {
      void this.prepareDefinition(
        parsed.settings,
        defaultAssignments(parsed.settings),
        `Applied the Combined Café Shift (${outcome.servedEspressoG.toFixed(1)} g espresso · ${outcome.packedFinanciers} packed financiers · ${bakers} worker${bakers > 1 ? "s" : ""}).`,
      );
    }
  },

  applyFinancierBatterToSchedule(
    this: ProductionWorkspace,
    outcome: Variant<FinancierBatterOutcome, "completed">,
  ): void {
    const currentSettings =
      this.props.session.data.kind === "ready"
        ? this.props.session.data.plan.settings
        : this.props.settings;
    const stage = outcome.emulsificationPct >= 95 ? 2 : 3;
    const traysPerBatch = outcome.mouldCavitiesYield >= 24 ? 2 : 1;
    const parsed = parseSettings({
      ...currentSettings,
      stage,
      traysPerBatch,
    });
    this.props.persistentOvenVisible(false);
    this.setState({
      financierBatter: null,
      calibratedBatter: outcome,
      menuHistory: [
        {
          panel: "workflow",
          catalogOpen: false,
          catalogSection: null,
          activeBatchId: null,
          authorRoute: this.state.authorRoute,
        },
      ],
      catalogOpen: false,
      catalogSection: "active-production",
      activeBatchId: null,
      panelHidden: false,
      transitionDirection: "forward",
    });
    if (parsed.kind === "valid") {
      void this.prepareDefinition(
        parsed.settings,
        calibratedHandoffAssignments(
          parsed.settings,
          this.state.handoffRecoveryPreset,
        ),
        `Applied Financier Batter calibration (${outcome.totalBatterG.toFixed(1)} g · ${outcome.mouldCavitiesYield} cavities): Stage ${stage} min · ${traysPerBatch} trays/batch.`,
      );
    }
  },

  applyFinancierBakeToSchedule(
    this: ProductionWorkspace,
    outcome: Variant<FinancierBakeOutcome, "completed">,
  ): void {
    const currentSettings =
      this.props.session.data.kind === "ready"
        ? this.props.session.data.plan.settings
        : this.props.settings;
    const piecesPerTray = outcome.acceptedPieces;
    const portion = Math.max(2, outcome.mouldCount * 2);
    const bake = outcome.peakOvenTempC >= 178 ? 14 : 15;
    const handoffPreset = outcome.handoffRecovery.preset;
    const cool = outcome.handoffRecovery.coolingBufferMin;
    const parsed = parseSettings({
      ...currentSettings,
      piecesPerTray,
      portion,
      bake,
      cool,
    });
    this.props.persistentOvenVisible(false);
    this.setState({
      financierBake: null,
      calibratedBake: outcome,
      handoffRecoveryPreset: handoffPreset,
      rackCase: handoffPreset === "nominal-handoff" ? "nominal" : "slip",
      menuHistory: [
        {
          panel: "workflow",
          catalogOpen: false,
          catalogSection: null,
          activeBatchId: null,
          authorRoute: this.state.authorRoute,
        },
      ],
      catalogOpen: false,
      catalogSection: "active-production",
      activeBatchId: null,
      panelHidden: false,
      transitionDirection: "forward",
    });
    if (parsed.kind === "valid") {
      const handoffNote =
        handoffPreset === "nominal-handoff"
          ? "Nominal cell 1 handoff"
          : `${outcome.handoffRecovery.summary}`;
      void this.prepareDefinition(
        parsed.settings,
        calibratedHandoffAssignments(parsed.settings, handoffPreset),
        `Applied Financier Bake calibration (${outcome.acceptedPieces} pcs @ ${outcome.pieceMassG.toFixed(1)} g · ${outcome.bakedFinanciersG.toFixed(1)} g): Portion ${portion} min · Bake ${bake} min · Cool ${cool} min · ${piecesPerTray} pcs/tray · ${handoffNote}.`,
      );
    }
  },

  applyHandoffRecoveryPreset(
    this: ProductionWorkspace,
    preset: FinancierHandoffRecoveryPreset,
  ): void {
    const currentSettings =
      this.props.session.data.kind === "ready"
        ? this.props.session.data.plan.settings
        : this.props.settings;
    const recovery = buildFinancierHandoffRecovery(preset);
    const parsed = parseSettings({
      ...currentSettings,
      cool: recovery.coolingBufferMin,
    });
    this.setState({
      handoffRecoveryPreset: preset,
      rackCase: preset === "nominal-handoff" ? "nominal" : "slip",
    });
    if (parsed.kind === "valid") {
      void this.prepareDefinition(
        parsed.settings,
        calibratedHandoffAssignments(parsed.settings, preset),
        `Applied Tier 2 → Tier 3 cell handoff preset (${recovery.preset}): ${recovery.summary}.`,
      );
    }
  },

  applyFinancierPackToSchedule(
    this: ProductionWorkspace,
    outcome: Variant<FinancierPackOutcome, "completed">,
  ): void {
    const currentSettings =
      this.props.session.data.kind === "ready"
        ? this.props.session.data.plan.settings
        : this.props.settings;
    const piecesPerTray = outcome.packedPieces;
    const demould = 2;
    const finishCooling = 10;
    const pack = outcome.packedPieces >= 15 ? 6 : 4;
    const parsed = parseSettings({
      ...currentSettings,
      piecesPerTray,
      demould,
      finishCooling,
      pack,
    });
    this.props.persistentOvenVisible(false);
    this.setState({
      financierPack: null,
      calibratedPack: outcome,
      menuHistory: [
        {
          panel: "workflow",
          catalogOpen: false,
          catalogSection: null,
          activeBatchId: null,
          authorRoute: this.state.authorRoute,
        },
      ],
      catalogOpen: false,
      catalogSection: "active-production",
      activeBatchId: null,
      panelHidden: false,
      transitionDirection: "forward",
    });
    if (parsed.kind === "valid") {
      void this.prepareDefinition(
        parsed.settings,
        calibratedHandoffAssignments(
          parsed.settings,
          this.state.handoffRecoveryPreset,
        ),
        `Applied Financier Pack calibration (${outcome.packedPieces} packed · ${outcome.packedNetMassG.toFixed(1)} g net): Demould ${demould} min · Crumb cool ${finishCooling} min · Pack ${pack} min · ${piecesPerTray} pcs/tray.`,
      );
    }
  },

  chooseAuthorRoute(
    this: ProductionWorkspace,
    authorRoute: string | null,
  ): void {
    if (
      (authorRoute === "cold-racking" || authorRoute === "oven-rack") &&
      authorRoute !== this.state.authorRoute
    )
      this.setState({
        menuHistory: [...this.state.menuHistory, this.currentMenuSnapshot()],
        authorRoute,
        transitionDirection: "forward",
      });
  },

  authorRouteChoice(this: ProductionWorkspace): React.ReactNode {
    return (
      <label>
        Production route
        <Select.Root
          items={AUTHOR_ROUTES}
          value={this.state.authorRoute}
          onValueChange={this.chooseAuthorRoute.bind(this)}
        >
          <Select.Trigger>
            <Select.Value />
          </Select.Trigger>
          <Select.Popup>{AUTHOR_ROUTES.map(renderItem)}</Select.Popup>
        </Select.Root>
      </label>
    );
  },
};

export const productionDefinitionFiles = {
  async openOvenFile(
    this: ProductionWorkspace,
    event: React.ChangeEvent<HTMLInputElement>,
  ): Promise<void> {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file === undefined) return;
    const generation = ++this.generation;
    this.update({ notice: "Checking the oven route file…" });
    try {
      const source = await readOvenRunFile(file);
      if (!this.mounted || generation !== this.generation) return;
      if (source.ok) this.showOven(source.value);
      else this.update({ notice: source.error });
    } catch (error) {
      if (this.mounted && generation === this.generation)
        this.update({ notice: message(error) });
    }
  },

  async openDefinition(
    this: ProductionWorkspace,
    scenarioId: string,
  ): Promise<void> {
    const connection = this.props.connection;
    if (
      connection.kind !== "workspace" ||
      this.props.session.openingDefinition ||
      this.props.session.savingDefinition
    )
      return;
    const id = scenarioId.trim();
    if (id === "") return;
    const generation = ++this.generation;
    this.props.playback.pause();
    this.update({
      openingDefinition: true,
      notice: "Opening production scenario…",
    });
    try {
      const opened = await readProductionScenario(
        connection.organisationId,
        id,
      );
      if (opened.kind !== "ready") throw new Error(opened.message);
      const definition = opened.definition;
      if (definition.route === "oven-rack") {
        const source = await prepareOvenDefinition(definition);
        if (!this.mounted || generation !== this.generation) return;
        if (source.ok) this.showOven(source.value);
        else this.update({ notice: source.error });
        return;
      }
      const plan = await compileProductionDraft(
        definition.settings,
        definition.assignments,
        definition.variant,
        definition,
        definition.manualTasks,
        definition.sourceFingerprint,
      );
      if (!this.mounted || generation !== this.generation) return;
      this.update({
        draft: definition.assignments,
        manualTasks: definition.manualTasks,
        presentation: definition.presentation,
        draftVariant: definition.variant,
        draftName: definition.name,
        draftNote: definition.note,
        identity: { kind: "saved", definition },
        sourceProcedure: opened.procedure,
        preview: readyProduction(plan, this.props.layout),
        notice: `Opened “${definition.name}” for review. Apply the preview to start a fresh run; native evidence remains separate.`,
      });
    } catch (error) {
      if (this.mounted && generation === this.generation)
        this.update({
          notice: `${message(error)} Your current run and draft are unchanged.`,
        });
    } finally {
      if (this.mounted && generation === this.generation)
        this.update({ openingDefinition: false });
    }
  },

  async saveDefinition(this: ProductionWorkspace): Promise<void> {
    const { connection } = this.props;
    const procedure =
      this.props.session.sourceProcedure ?? this.props.procedure;
    const preview = this.props.session.preview;
    const { identity, draftName, draftNote, draftVariant, draft } =
      this.props.session;
    if (
      connection.kind !== "workspace" ||
      !connection.canManage ||
      procedure === null ||
      this.props.session.savingDefinition ||
      this.props.session.openingDefinition ||
      identity.kind !== "new" ||
      preview === null
    )
      return;
    if (!settingsMatch(procedure.settings, preview.plan.settings)) {
      this.update({
        notice:
          "The production inputs differ from the loaded procedure. Apply the procedure inputs before saving.",
      });
      return;
    }
    const generation = this.generation;
    this.update({
      savingDefinition: true,
      notice: "Saving production scenario…",
    });
    try {
      const sourceFingerprint = await bakeryFingerprint(procedure.revisionKey);
      if (
        this.props.session.sourceProcedure === null &&
        this.props.session.data.kind === "ready" &&
        this.props.session.data.plan.source.kind === "shared" &&
        (procedure.reference.entityId !==
          this.props.session.data.plan.source.definition.procedureId ||
          sourceFingerprint !==
            this.props.session.data.plan.source.definition.sourceFingerprint)
      ) {
        this.update({
          notice:
            "Open the source scenario before saving edits to this production run.",
        });
        return;
      }
      const definitionFingerprint = await productionDefinitionFingerprint(
        sourceFingerprint,
        preview.plan.settings,
        draftVariant,
        draft,
        this.props.session.manualTasks,
        { route: "cold-racking" },
      );
      const definition = parseProductionScenario({
        id: identity.id,
        name: draftName.trim(),
        note: draftNote.trim(),
        procedureId: procedure.reference.entityId,
        sourceFingerprint,
        definitionFingerprint,
        settings: preview.plan.settings,
        variant: draftVariant,
        assignments: draft,
        manualTasks: this.props.session.manualTasks,
        presentation: this.props.session.presentation,
      });
      if (definition === null) {
        this.update({
          notice:
            "Enter a name and review the assigned trays, bakers and predecessors.",
        });
        return;
      }
      if (generation !== this.generation) return;
      const result = await saveProductionScenario(
        connection.organisationId,
        connection.mutate,
        definition,
      );
      if (!this.mounted) return;
      switch (result.kind) {
        case "verified": {
          if (
            currentDraft(this.props.session.identity, identity.id) &&
            generation === this.generation
          ) {
            const attached = await attachProductionScenario(
              preview.plan,
              result.definition,
            );
            if (attached.kind === "rejected") throw new Error(attached.message);
            if (!this.mounted) break;
            if (generation !== this.generation) {
              this.update({
                identity: identityAfterSave(
                  this.props.session.identity,
                  identity.id,
                  false,
                ),
                notice: `Saved “${definition.name}” as ${definition.id}. Current draft has newer changes.`,
              });
              break;
            }
            const active = this.props.session.data;
            if (
              active.kind === "ready" &&
              active.plan.fingerprint === preview.plan.fingerprint
            ) {
              const current = await attachProductionScenario(
                active.plan,
                result.definition,
              );
              if (current.kind === "rejected") throw new Error(current.message);
              if (!this.mounted) break;
              if (generation !== this.generation) {
                this.update({
                  identity: identityAfterSave(
                    this.props.session.identity,
                    identity.id,
                    false,
                  ),
                  notice: `Saved “${definition.name}” as ${definition.id}. Current draft has newer changes.`,
                });
                break;
              }
              this.update({
                data: readyProduction(current.plan, this.props.layout),
              });
            }
            this.update({
              identity: { kind: "saved", definition: result.definition },
              preview: readyProduction(attached.plan, this.props.layout),
              notice: `Saved and verified “${definition.name}”. Scenario ID: ${definition.id}.`,
            });
          } else {
            this.update({
              identity: identityAfterSave(
                this.props.session.identity,
                identity.id,
                false,
              ),
              notice: `Saved and verified “${definition.name}”. Scenario ID: ${definition.id}. Current draft has newer changes.`,
            });
          }
          break;
        }
        case "saved-readback-failed":
        case "outcome-unknown":
          this.update({
            identity: identityAfterSave(
              this.props.session.identity,
              identity.id,
              generation === this.generation,
            ),
            notice: result.message,
          });
          break;
        case "failed-before-save":
          this.update({ notice: result.message });
          break;
      }
    } catch (error) {
      if (this.mounted)
        this.update({
          identity: identityAfterSave(
            this.props.session.identity,
            identity.id,
            generation === this.generation,
          ),
          notice: message(error),
        });
    } finally {
      if (this.mounted) this.update({ savingDefinition: false });
    }
  },
};
