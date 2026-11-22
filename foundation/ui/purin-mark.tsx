import React, { useId } from "react";
import { joinClasses } from "./class-name";
import { PURIN_MARK } from "./purin-mark-paths";
import "./purin-mark.css";

export type PurinMarkProps = {
  /**
   * The cat sways, the pudding jiggles and the ears flick, one then the
   * other. The less-motion setting of the device stops the motion.
   */
  animated?: boolean;
  /** The accessible name. Without one, the mark is decoration. */
  label?: string;
  /** The width and the height in pixels. Without one, CSS sets the size. */
  size?: number;
  className?: string;
};

const { paths, colours, box } = PURIN_MARK;

/** A group that turns about `pivot`, so that CSS needs no origin in user units. */
function About({
  pivot,
  className,
  children,
}: {
  pivot: readonly [number, number];
  className: string;
  children: React.ReactNode;
}): React.ReactNode {
  return (
    <g transform={`translate(${pivot[0]} ${pivot[1]})`}>
      <g className={className}>
        <g transform={`translate(${-pivot[0]} ${-pivot[1]})`}>{children}</g>
      </g>
    </g>
  );
}

/**
 * The cat that moves: one shape that is drawn three times. The body stays,
 * and each ear is in a group that leans about the base of the ear.
 */
function CatWithEars({ id }: { id: string }): React.ReactNode {
  const { ears, earClips } = PURIN_MARK;
  const shape = `${id}-shape`;
  const part = (name: keyof typeof earClips): React.ReactNode => (
    <use href={`#${shape}`} clipPath={`url(#${id}-clip-${name})`} />
  );
  return (
    <g fill={colours.cat}>
      <defs>
        <path id={shape} d={paths.cat} />
        <clipPath id={`${id}-clip-body`}>
          <path clipRule="evenodd" d={earClips.body} />
        </clipPath>
        <clipPath id={`${id}-clip-left`}>
          <path d={earClips.left} />
        </clipPath>
        <clipPath id={`${id}-clip-right`}>
          <path d={earClips.right} />
        </clipPath>
      </defs>
      {part("body")}
      <About pivot={[ears.left, ears.base]} className="purin-mark-ear-left">
        {part("left")}
      </About>
      <About pivot={[ears.right, ears.base]} className="purin-mark-ear-right">
        {part("right")}
      </About>
    </g>
  );
}

/**
 * The drawing: the cat behind, the pudding in front. The cream gap round the
 * pudding is a cut-out in the cat, and it moves with the pudding. The mark
 * that does not move draws the cat as one shape.
 */
function Artwork({ animated }: { animated: boolean }): React.ReactNode {
  const id = useId();
  const gap = `${id}-gap`;
  const rim = `${id}-rim`;
  return (
    <>
      <defs>
        <mask
          id={gap}
          maskUnits="userSpaceOnUse"
          x="0"
          y="0"
          width={box}
          height={box}
        >
          <rect width={box} height={box} fill="#fff" />
          <About pivot={PURIN_MARK.puddingPivot} className="purin-mark-pudding">
            <path d={paths.gap} fill="#000" />
          </About>
        </mask>
        <clipPath id={rim}>
          <path d={paths.pudding} />
        </clipPath>
      </defs>
      <g mask={`url(#${gap})`}>
        <About pivot={PURIN_MARK.catPivot} className="purin-mark-cat">
          {animated ? (
            <CatWithEars id={id} />
          ) : (
            <path d={paths.cat} fill={colours.cat} />
          )}
          <path d={paths.face} fill={colours.cream} />
        </About>
      </g>
      <About pivot={PURIN_MARK.puddingPivot} className="purin-mark-pudding">
        <path d={paths.pudding} fill={colours.custard} />
        <path
          d={paths.caramel}
          fill={colours.caramel}
          fillRule="evenodd"
          clipPath={`url(#${rim})`}
        />
      </About>
    </>
  );
}

function Frame({
  viewBox,
  animated = false,
  label,
  size,
  className,
  children,
}: PurinMarkProps & {
  viewBox: string;
  children: React.ReactNode;
}): React.ReactNode {
  return (
    <svg
      className={joinClasses("purin-mark", className)}
      viewBox={viewBox}
      width={size}
      height={size}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-animated={animated ? "" : undefined}
    >
      {children}
    </svg>
  );
}

/**
 * The Purin cat mark on a transparent ground. The cat is dark, so use it on a
 * light surface. On a dark surface, use `PurinIcon`.
 */
export function PurinMark(props: PurinMarkProps): React.ReactNode {
  return (
    <Frame viewBox={PURIN_MARK.markViewBox} {...props}>
      <Artwork animated={props.animated ?? false} />
    </Frame>
  );
}

/**
 * The Purin cat mark on its cream tile. The tile carries its own ground, so
 * the icon reads on a light surface and on a dark surface.
 */
export function PurinIcon(props: PurinMarkProps): React.ReactNode {
  return (
    <Frame viewBox={PURIN_MARK.iconViewBox} {...props}>
      <rect
        width={box}
        height={box}
        rx={PURIN_MARK.iconRadius}
        fill={colours.cream}
      />
      <g transform={PURIN_MARK.iconTransform}>
        <Artwork animated={props.animated ?? false} />
      </g>
    </Frame>
  );
}
