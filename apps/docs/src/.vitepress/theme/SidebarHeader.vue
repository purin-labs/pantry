<script setup lang="ts">
import { computed, inject, ref, watchPostEffect } from "vue";
import { useData } from "vitepress";
import { VPImage, VPNavBarSearch } from "vitepress/theme";

const { isDark, site, theme } = useData();

const brandHref = computed(() => {
  const link = theme.value.logoLink;
  return (typeof link === "string" ? link : link?.link) ?? site.value.base;
});

const toggleAppearance = inject("toggle-appearance", () => {
  isDark.value = !isDark.value;
});

const switchTitle = ref(
  isDark.value ? "Switch to light theme" : "Switch to dark theme",
);
watchPostEffect(() => {
  switchTitle.value = isDark.value
    ? "Switch to light theme"
    : "Switch to dark theme";
});
</script>

<template>
  <div class="pantry-sidebar-header">
    <div class="pantry-sidebar-header__top">
      <a
        class="pantry-sidebar-header__brand"
        :href="brandHref"
        :aria-label="site.title"
      >
        <VPImage
          class="pantry-sidebar-header__logo"
          :image="theme.logo"
          alt=""
        />
        <span class="pantry-sidebar-header__wordmark" aria-hidden="true">
          <span>Seams Pantry</span>
          <small>Bakery operating system</small>
        </span>
      </a>
      <button
        class="pantry-sidebar-header__appearance"
        type="button"
        role="switch"
        :title="switchTitle"
        :aria-label="switchTitle"
        :aria-checked="isDark"
        @click="toggleAppearance"
      >
        <span class="vpi-sun sun" aria-hidden="true" />
        <span class="vpi-moon moon" aria-hidden="true" />
      </button>
    </div>
    <VPNavBarSearch class="pantry-sidebar-header__search" />
  </div>
</template>

<style scoped>
.pantry-sidebar-header {
  margin-bottom: 24px;
}

.pantry-sidebar-header__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
}

.pantry-sidebar-header__brand {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  border-radius: 8px;
  color: var(--vp-c-text-1);
  text-decoration: none;
}

.pantry-sidebar-header__brand:focus-visible,
.pantry-sidebar-header__appearance:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}

/* VPImage renders one image for each theme with no shared root, so the scoped
   attribute never reaches the images; :deep() sizes them. VitePress keeps the
   display rule that hides the image of the other theme. */
.pantry-sidebar-header__brand :deep(.pantry-sidebar-header__logo) {
  flex-shrink: 0;
  width: 30px;
  height: 30px;
}

.pantry-sidebar-header__wordmark {
  display: inline-flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  font-size: 17px;
  font-weight: 650;
  line-height: 1.15;
  letter-spacing: -0.02em;
  white-space: nowrap;
}

.pantry-sidebar-header__wordmark small {
  color: var(--vp-c-text-3);
  font-size: 11.5px;
  font-weight: 500;
  letter-spacing: 0;
}

.pantry-sidebar-header__appearance {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  width: 32px;
  height: 32px;
  color: var(--vp-c-text-2);
  transition:
    border-color 0.25s,
    color 0.25s;
}

.pantry-sidebar-header__appearance:hover {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
}

.sun,
.moon {
  width: 15px;
  height: 15px;
}

.pantry-sidebar-header__search {
  flex-grow: 0;
  padding: 0;
}

.pantry-sidebar-header__search :deep(#local-search) {
  flex-grow: 1;
  width: 100%;
}

.pantry-sidebar-header__search :deep(.DocSearch-Button) {
  margin: 0;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  width: 100%;
  height: 36px;
  background-color: var(--vp-c-bg);
  transition: border-color 0.25s;
}

.pantry-sidebar-header__search :deep(.DocSearch-Button:hover) {
  border-color: var(--vp-c-brand-1);
  box-shadow: none;
}

.pantry-sidebar-header__search :deep(.DocSearch-Button:focus-visible) {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}

.pantry-sidebar-header__search :deep(.DocSearch-Button-Container) {
  flex-grow: 1;
}

.pantry-sidebar-header__search :deep(.DocSearch-Button-Placeholder) {
  display: block;
  flex-grow: 1;
  padding: 0 8px;
  font-size: 13px;
  text-align: left;
}

.pantry-sidebar-header__search :deep(.DocSearch-Button-Keys) {
  display: flex;
  min-width: auto;
}

.moon,
.dark .sun {
  display: none;
}

.dark .moon {
  display: block;
}
</style>
