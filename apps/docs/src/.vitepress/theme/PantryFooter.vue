<script setup lang="ts">
const year = new Date().getFullYear();
</script>

<template>
  <footer class="pantry-docs-footer" aria-label="Seams Pantry footer">
    <div class="pantry-docs-footer__inner">
      <div class="pantry-docs-footer__brand">
        <a
          class="pantry-docs-footer__brand-link"
          href="/"
          aria-label="Seams Pantry documentation home"
        >
          <img
            class="pantry-docs-footer__mark pantry-docs-footer__mark--light"
            src="/brand/pantry-mark-dark-64.png"
            alt=""
            aria-hidden="true"
          />
          <img
            class="pantry-docs-footer__mark pantry-docs-footer__mark--dark"
            src="/brand/pantry-mark-light-64.png"
            alt=""
            aria-hidden="true"
          />
          <span>Seams Pantry</span>
        </a>
        <p class="pantry-docs-footer__legal">© {{ year }} Seams</p>
      </div>

      <nav class="pantry-docs-footer__links" aria-label="Footer navigation">
        <div class="pantry-docs-footer__group">
          <h2>Build</h2>
          <a href="/">Start here</a>
          <a href="/guides/first-operating-path">First operating path</a>
          <a href="/operate/local-development">Local development</a>
        </div>
        <div class="pantry-docs-footer__group">
          <h2>Learn</h2>
          <a href="/concepts/architecture">Architecture</a>
          <a href="/concepts/commerce-domain">Commerce domain</a>
          <a href="/concepts/authority-and-boundaries">Authority</a>
        </div>
        <div class="pantry-docs-footer__group">
          <h2>Operate</h2>
          <a href="/operate/testing-and-evidence">Testing and evidence</a>
          <a href="/operate/onboarding">Onboarding</a>
          <a href="/operate/vault">Vault operations</a>
        </div>
      </nav>
    </div>
  </footer>
</template>
