import { describe, expect, it } from 'vitest';
import { planInsertions, type MountStrategy } from './cartSections.js';

// The drawer is lenient (falls back to the panel) and puts the chooser INSIDE the items scroll region.
const DRAWER: MountStrategy = { chooserInsideItems: true, strict: false };
// The /cart page is strict (skip rather than mis-inject) and puts the chooser AFTER the items element.
const PAGE: MountStrategy = { chooserInsideItems: false, strict: true };

const all = { header: true, items: true, footer: true };

describe('planInsertions (pure mount planning)', () => {
  it('drawer, all anchors present: stepper after header, chooser inside the items region', () => {
    expect(planInsertions(DRAWER, all)).toEqual([
      { el: 'stepper', mode: 'afterend', anchor: 'header' },
      { el: 'chooser', mode: 'append', anchor: 'items' },
    ]);
  });

  it('page, all anchors present: stepper after header, chooser AFTER the items element', () => {
    expect(planInsertions(PAGE, all)).toEqual([
      { el: 'stepper', mode: 'afterend', anchor: 'header' },
      { el: 'chooser', mode: 'afterend', anchor: 'items' },
    ]);
  });

  it('page is STRICT: a missing anchor is skipped, never injected in the wrong place', () => {
    const plan = planInsertions(PAGE, { header: false, items: false, footer: false });
    expect(plan).toEqual([
      { el: 'stepper', mode: 'skip', anchor: 'panel' },
      { el: 'chooser', mode: 'skip', anchor: 'items' },
    ]);
  });

  it('drawer is LENIENT: falls back to the panel (header) and the footer (chooser)', () => {
    expect(planInsertions(DRAWER, { header: false, items: false, footer: true })).toEqual([
      { el: 'stepper', mode: 'prepend', anchor: 'panel' },
      { el: 'chooser', mode: 'beforebegin', anchor: 'footer' },
    ]);
  });

  it('drawer with no items and no footer: chooser falls back to appending the panel', () => {
    expect(planInsertions(DRAWER, { header: true, items: false, footer: false })).toEqual([
      { el: 'stepper', mode: 'afterend', anchor: 'header' },
      { el: 'chooser', mode: 'append', anchor: 'panel' },
    ]);
  });
});
