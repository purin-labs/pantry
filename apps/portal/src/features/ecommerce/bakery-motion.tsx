import React from "react";

const studies = [
  {
    source: "demand-terrain",
    title: "Plan the next batch",
    copy: "Connect demand, recipes, and production plans. Give each bake its place in the day.",
    hint: "Hover or tap a tray to lift the financiers.",
  },
  {
    source: "oven-rack",
    title: "Train where the work happens",
    copy: "Refine agents with real bakery and café routines, operator feedback, and on-site examples.",
    hint: "Hover or tap an oven to open its door.",
  },
  {
    source: "packing-slow",
    title: "Bring the order together",
    copy: "Connect packing and inventory to ecommerce orders, dispatch, and customer service.",
    hint: "Hover or tap a gift box to pause and inspect it. Tap again to close.",
  },
] as const;

function renderStudy(study: (typeof studies)[number]): React.JSX.Element {
  return (
    <article className="h2-bakery-study" key={study.source}>
      <iframe
        className="h2-bakery-study__figure"
        src={`/ecommerce/motion/index.html?study=${study.source}`}
        title={`${study.title} — interactive bakery illustration`}
        loading="lazy"
      />
      <p className="h2-bakery-study__hint">{study.hint}</p>
      <h3>{study.title}</h3>
      <p>{study.copy}</p>
    </article>
  );
}

export function BakeryMotion(): React.JSX.Element {
  return (
    <section
      className="h2-section h2-rule"
      aria-labelledby="bakery-motion-title"
    >
      <div className="h2-shell">
        <div className="h2-split-head">
          <p className="h2-kicker">Kitchen + Café</p>
          <h2 id="bakery-motion-title" className="h2-display">
            From the first batch to the final order
          </h2>
          <p className="h2-split-head__copy">
            Agents learn the daily work through real deployments, training, and
            fine-tuning with your team. Connect production to agentic ecommerce
            across the bakery and café.
          </p>
        </div>
        <div className="h2-bakery-studies">{studies.map(renderStudy)}</div>
        <article className="h2-bakery-rehearsal" id="maruzen-rehearsal">
          <div className="h2-bakery-rehearsal__copy">
            <p className="h2-kicker">Maruzen / MBCO-5E</p>
            <h3>
              Teach the routine.
              <br />
              Refine the shift.
            </h3>
            <p>
              Follow a tray into the oven. Review access, alignment, and
              placement with your team before work begins.
            </p>
            <p className="h2-bakery-rehearsal__hint">
              Run the rehearsal, or choose a stage to inspect the handoff.
            </p>
          </div>
          <iframe
            className="h2-bakery-rehearsal__figure"
            src="/ecommerce/maruzen/index.html"
            title="Maruzen oven — interactive loading rehearsal"
            loading="lazy"
          />
        </article>
        <p className="h2-bakery-note">
          Illustrative workflows. Equipment and handling need validation in the
          real environment.
        </p>
      </div>
    </section>
  );
}
