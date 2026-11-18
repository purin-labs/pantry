<script setup lang="ts">
import { computed, ref } from "vue";
import { useData } from "vitepress";
import type { DefaultTheme } from "vitepress/theme";

const { frontmatter, page, theme } = useData();
const copied = ref(false);

function normalize(link: string): string {
  const path = link.replace(/index\.md$/, "").replace(/\.md$/, "");
  const noTrailing = path !== "/" ? path.replace(/\/$/, "") : path;
  return noTrailing.startsWith("/") ? noTrailing : `/${noTrailing}`;
}

const currentPath = computed(() => normalize(`/${page.value.relativePath}`));

function findTrail(
  items: DefaultTheme.SidebarItem[],
  trail: DefaultTheme.SidebarItem[],
): DefaultTheme.SidebarItem[] | null {
  for (const item of items) {
    const next = [...trail, item];
    if (item.link && normalize(item.link) === currentPath.value) return next;
    if (item.items) {
      const found = findTrail(item.items, next);
      if (found) return found;
    }
  }
  return null;
}

const crumbs = computed(() => {
  const sidebar = theme.value.sidebar;
  if (!Array.isArray(sidebar)) return [];
  const trail = findTrail(sidebar as DefaultTheme.SidebarItem[], []);
  return trail && trail.length > 1 ? trail.slice(0, -1) : [];
});

function resetCopied(): void {
  copied.value = false;
}

async function copyPage(): Promise<void> {
  const body = document.querySelector(".vp-doc")?.textContent?.trim();
  if (!body) return;
  try {
    await navigator.clipboard.writeText(`# ${page.value.title}\n\n${body}`);
    copied.value = true;
    window.setTimeout(resetCopied, 2000);
  } catch {
    copied.value = false;
  }
}
</script>

<template>
  <header class="pantry-doc-header">
    <div class="pantry-doc-header__bar">
      <nav
        v-if="crumbs.length"
        class="pantry-doc-header__breadcrumb"
        aria-label="Breadcrumb"
      >
        <template v-for="(crumb, index) in crumbs" :key="crumb.text">
          <a v-if="crumb.link" :href="crumb.link">{{ crumb.text }}</a>
          <span v-else>{{ crumb.text }}</span>
          <span
            v-if="index < crumbs.length - 1"
            class="pantry-doc-header__sep"
            aria-hidden="true"
          >
            ›
          </span>
        </template>
      </nav>
      <span v-else />
      <button class="pantry-doc-header__copy" type="button" @click="copyPage">
        <svg
          aria-hidden="true"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <rect width="14" height="14" x="8" y="8" rx="2" />
          <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1 0-2 2-2h10c1.1 0 2 .9 2 2" />
        </svg>
        {{ copied ? "Copied" : "Copy page" }}
      </button>
    </div>
    <h1 class="pantry-doc-header__title">{{ page.title }}</h1>
    <p v-if="frontmatter.subtitle" class="pantry-doc-header__lead">
      {{ frontmatter.subtitle }}
    </p>
    <p v-if="frontmatter.description" class="pantry-doc-header__subtitle">
      {{ frontmatter.description }}
    </p>
  </header>
</template>

<style scoped>
.pantry-doc-header {
  margin-bottom: 32px;
}

.pantry-doc-header__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 32px;
  margin-bottom: 12px;
}

.pantry-doc-header__title {
  margin: 0;
  font-size: 36px;
  font-weight: 700;
  line-height: 1.15;
  letter-spacing: -0.02em;
  color: var(--vp-c-text-1);
}

.pantry-doc-header__lead {
  margin: 6px 0 0;
  font-size: 21px;
  font-weight: 600;
  line-height: 1.35;
  letter-spacing: -0.01em;
  color: var(--vp-c-text-2);
}

.pantry-doc-header__subtitle {
  margin: 10px 0 0;
  font-size: 17px;
  line-height: 1.6;
  color: var(--vp-c-text-2);
}

.pantry-doc-header__breadcrumb {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 14px;
  color: var(--vp-c-text-2);
}

.pantry-doc-header__breadcrumb a {
  color: var(--vp-c-text-2);
  text-decoration: none;
  transition: color 0.25s;
}

.pantry-doc-header__breadcrumb a:hover {
  color: var(--vp-c-brand-1);
}

.pantry-doc-header__sep {
  color: var(--vp-c-text-3);
}

.pantry-doc-header__copy {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  border: 1px solid var(--vp-c-border);
  border-radius: 8px;
  padding: 4px 12px;
  color: var(--vp-c-text-2);
  font-size: 13px;
  font-weight: 500;
  transition:
    color 0.25s,
    border-color 0.25s;
}

.pantry-doc-header__copy:hover {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
}

.pantry-doc-header__copy:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}
</style>
