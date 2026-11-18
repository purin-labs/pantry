# Maruzen loading rehearsal

The ecommerce landing page loads this standalone scene in a lazy iframe.
Run rehearsal opens the door, inserts the tray and closes the door. Inspect,
Place and Review select individual poses. Reduced motion selects static poses.
Rendering stops when the scene is idle, offscreen or on a hidden page.

The model comes from `assets/bakery-mujoco/maruzen-mbco-5e/maruzen-mbco-5e.glb`.
The scene and procedural pastries come from the reviewed Maruzen study under
`output/plan-65-hairline-svgs/training-bench/maruzen-rehearsal/`.
The bundled Three.js modules retain their license in `vendor/LICENSE`.

This is an illustrative loading sequence. It does not run physics or control
machinery. Equipment dimensions and handling require field validation.

For browser review, open `/ecommerce`, scroll to the Maruzen section, run the
complete rehearsal, then select Place and Inspect to reverse the tray motion.
Check the controls and absence of horizontal overflow at 390px width.
