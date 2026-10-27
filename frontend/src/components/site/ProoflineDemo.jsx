import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { PROOF_STAGES, SAMPLE_RESULT, formatInr } from './sampleResult';

/**
 * The Proofline: one sample payroll result, traced to the evidence behind it.
 *
 * The red line runs from the result to the selected stage. Every stage summary
 * is always visible, so the chain reads without hover, motion or a wide screen;
 * selecting a stage opens its evidence and moves the trace to it.
 */
export default function ProoflineDemo() {
  const [selected, setSelected] = useState(PROOF_STAGES.length - 1);
  const [geometry, setGeometry] = useState(null);
  const traceRef = useRef(null);
  const nodeRefs = useRef([]);

  // Line lengths are measured, not assumed: summaries wrap differently at every width.
  const measure = useCallback(() => {
    const trace = traceRef.current;
    const nodes = nodeRefs.current;
    if (!trace || !nodes[selected] || !nodes[nodes.length - 1]) return;
    const top = trace.getBoundingClientRect().top;
    const centre = (node) => {
      const box = node.getBoundingClientRect();
      return Math.round(box.top + box.height / 2 - top);
    };
    const next = { trace: centre(nodes[selected]), rail: centre(nodes[nodes.length - 1]) };
    setGeometry((prev) => (prev && prev.trace === next.trace && prev.rail === next.rail ? prev : next));
  }, [selected]);

  useLayoutEffect(() => {
    measure();
    if (typeof ResizeObserver === 'undefined' || !traceRef.current) return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(traceRef.current);
    return () => observer.disconnect();
  }, [measure]);

  return (
    <figure className="proof-demo" aria-labelledby="proof-demo-title">
      <div className="proof-demo__head">
        <span className="proof-sample">Sample data</span>
        <span className="proof-meta">
          {SAMPLE_RESULT.period} · {SAMPLE_RESULT.employee} · {SAMPLE_RESULT.location}
        </span>
      </div>

      <div className="proof-result">
        <p className="proof-label" id="proof-demo-title">Net pay before TDS</p>
        <p className="proof-amount">{formatInr(SAMPLE_RESULT.netPayBeforeTds)}</p>
        <dl className="proof-lines">
          {SAMPLE_RESULT.lines.map((line) => (
            <div className="proof-lines__row" key={line.label}>
              <dt>{line.label}</dt>
              <dd className={line.note ? 'is-note' : undefined}>
                {line.note || formatInr(line.amount)}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <p className="proof-traced">
        <span aria-hidden="true">Traced to</span>
        <span className="proof-traced__hint">Select a stage to see its evidence</span>
      </p>
      <div
        className="proof-trace"
        ref={traceRef}
        style={geometry ? { '--proof-trace': `${geometry.trace}px`, '--proof-rail': `${geometry.rail}px` } : undefined}
        data-measured={geometry ? '' : undefined}
      >
        <span className="proof-rail" aria-hidden="true" />
        <span className="proof-rail proof-rail--lit" aria-hidden="true" />
        <span className="proof-pulse" aria-hidden="true" />
        <ol className="proof-stages" aria-label="Evidence behind this result">
          {PROOF_STAGES.map((stage, index) => {
            const open = index === selected;
            const panelId = `proof-stage-${stage.id}`;
            const classes = ['proof-stage', open && 'is-open', index <= selected && 'is-traced'].filter(Boolean).join(' ');
            return (
              <li key={stage.id} className={classes}>
                <button
                  type="button"
                  className="proof-stage__button"
                  aria-expanded={open}
                  aria-controls={panelId}
                  onClick={() => setSelected(index)}
                >
                  <span className="proof-node" ref={(el) => { nodeRefs.current[index] = el; }} aria-hidden="true" />
                  <span className="proof-stage__index" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                  <span className="proof-stage__text">
                    <span className="proof-stage__title">{stage.title}</span>
                    <span className="proof-stage__summary">{stage.summary}</span>
                  </span>
                </button>
                <div className="proof-stage__panel" id={panelId} hidden={!open}>
                  <dl className="proof-facts">
                    {stage.facts.map(([term, value]) => (
                      <div className="proof-facts__row" key={term}>
                        <dt>{term}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className="proof-note">{stage.note}</p>
                  <p className="proof-where"><span>In PayGuard</span> {stage.where}</p>
                </div>
              </li>
            );
          })}
        </ol>
      </div>

      <figcaption className="proof-caption">
        Illustrative example, not data from any workspace. Figures follow PayGuard’s baseline EPF, ESI and
        Maharashtra professional-tax rules.
      </figcaption>
    </figure>
  );
}
