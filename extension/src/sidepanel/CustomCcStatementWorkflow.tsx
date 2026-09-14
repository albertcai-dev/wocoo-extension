// Custom CC Statement workflow — 4 steps with a success state.
//
// Issues a corrected credit card statement when the statement Wealthsimple generated
// carries stale client data (almost always an outdated mailing address) AND the error is
// ours. See WOCOO-28171.
//
// Step 1: Import statement — the client's real statement PDF, parsed in-panel by pdf.js.
//         The file never leaves the machine.
// Step 2: Verify parse — every parsed field editable, with the activity rows listed and
//         any parser warnings surfaced. Nothing is generated from unreviewed numbers.
// Step 3: Corrected address — pulled headlessly from Atlas, shown beside the stale
//         address from the PDF so the correction is visible.
// Step 4: Generate — chunked bridge calls build the Doc, then export the PDF, attach it
//         to the ticket and log the ticket.
// Step 5: Success — Doc + PDF links, plus the manual tail (Atlas upload + access macro).
//
// Visual conventions match RefundAuthLetterWorkflow.tsx.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { WocooTicket } from '../data/mockTicket';
import { fetchAtlasClientDetailsHeadless } from '../data/atlasAccountLookup';
import { addAttachment, base64ToBlob } from '../api/jira';
import {
  CC_STATEMENT_ROWS_PER_CALL,
  appendCcStatementRowsViaBridge,
  createCcStatementViaBridge,
  finalizeCcStatementViaBridge,
  logTicketViaBridge,
  type CcStatementFinalizeResult,
} from '../api/bridge';
import { extractStatementText, StatementPdfError } from '../data/ccStatementPdf';
import { parseStatement, type ParsedStatement, type StatementActivityRow } from '../data/ccStatementParse';

type StepNum = 1 | 2 | 3 | 4 | 5;

const STEP_TITLES: Record<StepNum, string> = {
  1: 'Import statement',
  2: 'Verify parsed statement',
  3: 'Corrected address',
  4: 'Generate',
  5: 'Complete',
};

const STEP_SUBTITLES: Record<StepNum, string> = {
  1: "The client's existing statement PDF",
  2: 'Check the numbers before anything is generated',
  3: 'Pulled from Atlas — this is the correction',
  4: 'Builds the Doc, exports the PDF',
  5: '',
};

/** The header + summary fields the operator can review and edit on step 2. */
const EDITABLE_FIELDS = [
  ['cardMasked', 'Credit card account'],
  ['statementDate', 'Statement date'],
  ['openingDate', 'Opening date'],
  ['closingDate', 'Closing date'],
  ['paymentDueDate', 'Payment due date'],
  ['creditLimit', 'Credit limit'],
  ['minimumPayment', 'Minimum payment'],
  ['statementBalance', 'Statement balance'],
  ['previousBalance', 'Previous balance'],
  ['payments', 'Payments'],
  ['otherCredits', 'Other credits'],
  ['purchases', 'Purchases'],
  ['fees', 'Fees'],
  ['interest', 'Interest'],
  ['cashAdvances', 'Cash advances'],
  ['totalCharges', 'Total charges'],
  ['totalPaymentsCredits', 'Total payments/credits'],
  ['newBalance', 'New balance'],
  ['annualInterestRate', 'Annual interest rate'],
  ['cashAdvanceInterestRate', 'Cash advance interest rate'],
] as const;

type FieldKey = (typeof EDITABLE_FIELDS)[number][0];
type FieldValues = Record<FieldKey, string>;

const EMPTY_FIELDS = Object.fromEntries(EDITABLE_FIELDS.map(([k]) => [k, ''])) as FieldValues;

export function CustomCcStatementWorkflow({ ticket, onClose }: { ticket: WocooTicket; onClose: () => void }) {
  const [step, setStep] = useState<StepNum>(1);

  // Step 1 — import
  const [fileName, setFileName] = useState('');
  const [parseState, setParseState] = useState<'idle' | 'pending' | 'done' | 'error'>('idle');
  const [parseError, setParseError] = useState<string | null>(null);
  const [rawText, setRawText] = useState<string[][] | null>(null);
  const [parsed, setParsed] = useState<ParsedStatement | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Step 2 — verify (editable copies; `parsed` stays the pristine record)
  const [fields, setFields] = useState<FieldValues>(EMPTY_FIELDS);
  const [rows, setRows] = useState<StatementActivityRow[]>([]);
  const [rowsExpanded, setRowsExpanded] = useState(false);

  // Step 3 — corrected address
  const [clientName, setClientName] = useState('');
  const [street, setStreet] = useState('');
  const [cityProvince, setCityProvince] = useState('');
  const [postal, setPostal] = useState('');
  const [atlasState, setAtlasState] = useState<'idle' | 'pending' | 'done' | 'error'>('idle');
  const [atlasError, setAtlasError] = useState<string | null>(null);
  const [atlasPartial, setAtlasPartial] = useState(false);

  // Step 4 — generation
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  /** Set the moment the Doc exists, so a later chunk failure still surfaces the link. */
  const [partialDocUrl, setPartialDocUrl] = useState<string | null>(null);
  const [result, setResult] = useState<CcStatementFinalizeResult | null>(null);

  // Atlas is only worth spending on once the operator reaches step 3 — plenty of runs
  // stop at step 2 when the parse looks wrong. The `idle` check keeps Back/Continue
  // from re-fetching.
  useEffect(() => {
    if (step !== 3 || atlasState !== 'idle' || !ticket.identityId) return;
    void runAtlasFetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, ticket.identityId]);

  async function handleFile(file: File | null | undefined) {
    if (!file) return;
    setFileName(file.name);
    setParseState('pending');
    setParseError(null);
    setRawText(null);
    try {
      const pages = await extractStatementText(file);
      setRawText(pages);
      const statement = parseStatement(pages);
      setParsed(statement);
      setFields(fieldsFromParsed(statement));
      setRows(statement.rows);
      setParseState('done');
    } catch (e) {
      setParsed(null);
      setRows([]);
      setParseState('error');
      setParseError(
        e instanceof StatementPdfError
          ? e.message
          : `Could not parse that statement (${e instanceof Error ? e.message : String(e)}).`,
      );
    }
  }

  async function runAtlasFetch() {
    if (!ticket.identityId) { setAtlasError('This ticket has no identity ID.'); setAtlasState('error'); return; }
    setAtlasState('pending');
    setAtlasError(null);
    try {
      const d = await fetchAtlasClientDetailsHeadless({ identityId: ticket.identityId, sourceTicketId: ticket.id });
      if (d.name) setClientName(titleCaseName(d.name));
      if (d.street) setStreet(clean(d.street));
      if (d.cityProvince) setCityProvince(expandProvince(clean(d.cityProvince)));
      if (d.postal) setPostal(formatPostal(d.postal));
      setAtlasPartial(!d.complete);
      setAtlasState('done');
    } catch (e) {
      setAtlasError(e instanceof Error ? e.message : String(e));
      setAtlasState('error');
    }
  }

  const openAtlas = () => {
    if (!ticket.identityId) return;
    window.open(
      `https://atlas.wealthsimple.com/identity/${ticket.identityId}/overview/?ticketId=${ticket.id}`,
      '_blank',
      'noopener,noreferrer',
    );
  };

  /** "August 25, 2026" -> "August 2026", for the Doc title. */
  const periodLabel = useMemo(() => {
    const m = fields.statementDate.match(/^([A-Za-z]+)\s+\d{1,2},?\s*(\d{4})$/);
    return m ? `${m[1]} ${m[2]}` : fields.statementDate;
  }, [fields.statementDate]);

  const step1Ready = parseState === 'done' && rows.length > 0;
  const step2Ready = Boolean(fields.statementDate.trim() && fields.newBalance.trim() && rows.length > 0);
  const step3Ready = Boolean(clientName.trim() && street.trim() && cityProvince.trim() && postal.trim());

  async function generate() {
    setBusy(true);
    setError(null);
    setWarning(null);
    setPartialDocUrl(null);
    try {
      setProgress('Copying the template…');
      const created = await createCcStatementViaBridge({
        clientName: clean(clientName),
        addressStreet: clean(street),
        addressCityProvince: clean(cityProvince),
        addressPostal: clean(postal),
        ...fields,
        statementPeriodLabel: periodLabel,
        wocooTicketId: ticket.id,
      });
      setPartialDocUrl(created.docUrl);

      for (let i = 0; i < rows.length; i += CC_STATEMENT_ROWS_PER_CALL) {
        const batch = rows.slice(i, i + CC_STATEMENT_ROWS_PER_CALL);
        setProgress(`Adding activity rows ${i + 1}–${i + batch.length} of ${rows.length}…`);
        await appendCcStatementRowsViaBridge({
          docId: created.docId,
          startIndex: i,
          totalRows: rows.length,
          rows: batch,
        });
      }

      setProgress('Exporting the PDF…');
      const finalized = await finalizeCcStatementViaBridge({ docId: created.docId, includePdfBase64: true });
      setResult(finalized);

      // The statement exists at this point. Attachment and logging failures are warnings,
      // never a reason to lose the links.
      const followUps: string[] = [];
      if (finalized.pdfBase64) {
        try {
          await addAttachment(ticket.id, `${finalized.fileName}.pdf`, base64ToBlob(finalized.pdfBase64, 'application/pdf'));
        } catch (e) {
          followUps.push(`PDF not attached (${e instanceof Error ? e.message : String(e)})`);
        }
      } else {
        followUps.push('Bridge returned no PDF bytes, so nothing was attached.');
      }
      try {
        await logTicketViaBridge({
          ticketId: ticket.id,
          ticketLink: `https://wealthsimple.atlassian.net/browse/${ticket.id}`,
          summary: ticket.summary || '',
          descriptionSnippet: (ticket.description || '').slice(0, 500),
          originalWorkType: ticket.workType || '',
          finalWorkType: '',
          transition: 'Done',
          movedToBoard: '',
          timeOnTicketMinutes: 0,
        });
      } catch (e) {
        followUps.push(`Ticket Log not written (${e instanceof Error ? e.message : String(e)})`);
      }
      if (followUps.length) setWarning(followUps.join(' · '));

      setStep(5);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setProgress('');
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%', background: 'var(--mint-bg-page)' }}>
      <Header step={step} ticketId={ticket.id} onClose={onClose} />
      <div style={{ display: 'flex', gap: 'var(--mint-sp-2)', padding: 'var(--mint-sp-3) var(--mint-sp-3) 0' }}>
        <button
          onClick={openAtlas}
          disabled={!ticket.identityId}
          title={ticket.identityId ? "Open this client's Atlas overview" : 'No identity ID on this ticket'}
          style={{ ...refLinkButton, background: 'var(--mint-positive-fg-graphic)', opacity: ticket.identityId ? 1 : 0.5, cursor: ticket.identityId ? 'pointer' : 'not-allowed' }}
        >
          ↗ Atlas
        </button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--mint-sp-2)', padding: 'var(--mint-sp-3)' }}>
        {step === 5 && result ? (
          <SuccessPanel result={result} warning={warning} ticketId={ticket.id} onCloseToTicket={onClose} />
        ) : (
          <>
            <ExpandedCard n={1} completed={step > 1}>
              {step === 1 ? (
                <>
                  <div
                    onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragging(false);
                      void handleFile(e.dataTransfer.files?.[0]);
                    }}
                    onClick={() => fileInputRef.current?.click()}
                    style={{
                      padding: 'var(--mint-sp-4) var(--mint-sp-3)',
                      textAlign: 'center',
                      border: `1.5px dashed ${dragging ? 'var(--mint-fg-strong)' : 'var(--mint-outline-strong)'}`,
                      borderRadius: 'var(--mint-radius-card)',
                      background: dragging ? 'var(--mint-bg-subtle)' : 'var(--mint-bg-card)',
                      cursor: 'pointer',
                    }}
                  >
                    <div style={{ fontSize: 22, marginBottom: 4 }}>🧾</div>
                    <div style={{ fontSize: 'var(--mint-text-meta)', fontWeight: 600, color: 'var(--mint-fg-strong)' }}>
                      {parseState === 'pending' ? 'Parsing…' : 'Drop the statement PDF, or click to pick'}
                    </div>
                    <div style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)', marginTop: 4, lineHeight: 1.45 }}>
                      Parsed on this machine — the file is never uploaded anywhere.
                    </div>
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="application/pdf,.pdf"
                    onChange={(e) => { void handleFile(e.target.files?.[0]); }}
                    style={{ display: 'none' }}
                  />
                  {fileName ? (
                    <div style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)', marginTop: 6 }}>
                      {fileName}
                    </div>
                  ) : null}
                  {parseError ? <div style={{ marginTop: 'var(--mint-sp-2)' }}><ErrorLine text={parseError} /></div> : null}
                  {parseState === 'done' && rows.length === 0 ? (
                    <div style={{ marginTop: 'var(--mint-sp-2)' }}>
                      <ErrorLine text="Found no activity rows in that PDF. Either it is not a Wealthsimple credit card statement, or the statement layout changed and the parser needs updating." />
                    </div>
                  ) : null}
                  {rawText && rows.length === 0 ? <RawTextDump pages={rawText} /> : null}
                  {parseState === 'done' && rows.length > 0 ? (
                    <div style={{ fontSize: 'var(--mint-text-micro)', color: 'var(--mint-positive-fg-strong)', marginTop: 'var(--mint-sp-2)' }}>
                      ✓ Parsed {rows.length} activity row{rows.length === 1 ? '' : 's'} across {rawText?.length ?? 0} pages
                    </div>
                  ) : null}
                  <button
                    onClick={() => setStep(2)}
                    disabled={!step1Ready}
                    style={{ ...primaryButton, width: '100%', marginTop: 'var(--mint-sp-3)', opacity: step1Ready ? 1 : 0.5, cursor: step1Ready ? 'pointer' : 'not-allowed' }}
                  >
                    Continue
                  </button>
                </>
              ) : (
                <Summary lines={[fileName, `${rows.length} activity rows · ${fields.statementDate}`]} />
              )}
            </ExpandedCard>

            {step >= 2 ? (
              <ExpandedCard n={2} completed={step > 2}>
                {step === 2 ? (
                  <>
                    {parsed?.warnings.length ? (
                      <div style={{ marginBottom: 'var(--mint-sp-2)' }}>
                        {parsed.warnings.map((w, i) => <WarningLine key={i} text={w} />)}
                      </div>
                    ) : (
                      <div style={{ fontSize: 'var(--mint-text-micro)', color: 'var(--mint-positive-fg-strong)', marginBottom: 'var(--mint-sp-2)' }}>
                        ✓ No parser warnings — activity totals reconcile with the summary
                      </div>
                    )}

                    <div style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)', marginBottom: 'var(--mint-sp-2)', lineHeight: 1.45 }}>
                      These are copied from the client's statement as-is. Only the address is being
                      corrected — if a number here is wrong, this is the wrong tool.
                    </div>

                    {EDITABLE_FIELDS.map(([key, label]) => (
                      <Field
                        key={key}
                        label={label}
                        value={fields[key]}
                        onChange={(v) => setFields((f) => ({ ...f, [key]: v }))}
                      />
                    ))}

                    <button onClick={() => setRowsExpanded((v) => !v)} style={{ ...secondaryButton, width: '100%', marginBottom: 'var(--mint-sp-2)' }}>
                      {rowsExpanded ? '▾' : '▸'} {rows.length} activity rows
                    </button>
                    {rowsExpanded ? <RowTable rows={rows} /> : null}

                    <div style={{ display: 'flex', gap: 'var(--mint-sp-2)', marginTop: 'var(--mint-sp-2)' }}>
                      <button onClick={() => setStep(1)} style={secondaryButton}>← Back</button>
                      <button
                        onClick={() => setStep(3)}
                        disabled={!step2Ready}
                        style={{ ...primaryButton, flex: 1, opacity: step2Ready ? 1 : 0.5, cursor: step2Ready ? 'pointer' : 'not-allowed' }}
                      >
                        Continue
                      </button>
                    </div>
                  </>
                ) : (
                  <Summary lines={[`${fields.statementDate} · ${fields.newBalance}`, `${rows.length} activity rows`]} />
                )}
              </ExpandedCard>
            ) : (
              <FutureStub n={2} />
            )}

            {step >= 3 ? (
              <ExpandedCard n={3} completed={step > 3}>
                {step === 3 ? (
                  <>
                    <div style={{ display: 'flex', gap: 'var(--mint-sp-2)', alignItems: 'center', marginBottom: 'var(--mint-sp-2)' }}>
                      <button
                        onClick={() => { void runAtlasFetch(); }}
                        disabled={atlasState === 'pending' || !ticket.identityId}
                        style={{ ...secondaryButton, opacity: atlasState === 'pending' || !ticket.identityId ? 0.6 : 1 }}
                      >
                        {atlasState === 'pending' ? '… Fetching from Atlas' : '↗ Fetch from Atlas'}
                      </button>
                      {atlasState === 'done' ? (
                        <span style={{ fontSize: 'var(--mint-text-micro)', color: atlasPartial ? 'var(--mint-warning-fg-strong)' : 'var(--mint-positive-fg-strong)' }}>
                          {atlasPartial ? '⚠ Partial — fill the blanks' : '✓ Fetched'}
                        </span>
                      ) : null}
                    </div>
                    {atlasError ? <ErrorLine text={atlasError} /> : null}

                    {parsed ? <StaleAddress parsed={parsed} /> : null}

                    <Field label="Client full legal name" value={clientName} onChange={setClientName} />
                    <Field label="Street (incl. unit)" value={street} onChange={setStreet} />
                    <Field label="City, Province" value={cityProvince} onChange={setCityProvince} />
                    <Field label="Postal code" value={postal} onChange={setPostal} />
                    <div style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)', marginBottom: 'var(--mint-sp-2)', lineHeight: 1.45 }}>
                      Template conventions: title-case name, province spelled out
                      (“Ontario”, not “ON”), postal code with a space.
                    </div>

                    <div style={{ display: 'flex', gap: 'var(--mint-sp-2)' }}>
                      <button onClick={() => setStep(2)} style={secondaryButton}>← Back</button>
                      <button
                        onClick={() => setStep(4)}
                        disabled={!step3Ready}
                        style={{ ...primaryButton, flex: 1, opacity: step3Ready ? 1 : 0.5, cursor: step3Ready ? 'pointer' : 'not-allowed' }}
                      >
                        Continue
                      </button>
                    </div>
                  </>
                ) : (
                  <Summary lines={[clientName, street, `${cityProvince}  ${postal}`]} />
                )}
              </ExpandedCard>
            ) : (
              <FutureStub n={3} />
            )}

            {step >= 4 ? (
              <ExpandedCard n={4}>
                <StatementPreview
                  clientName={clientName}
                  street={street}
                  cityProvince={cityProvince}
                  postal={postal}
                  fields={fields}
                  rowCount={rows.length}
                />
                {error ? <ErrorLine text={error} /> : null}
                {error && partialDocUrl ? (
                  <div style={{ marginBottom: 'var(--mint-sp-2)' }}>
                    <WarningLine text="The Doc was created before this failed, so nothing is lost — open it and finish by hand rather than re-running." />
                    <a href={partialDocUrl} target="_blank" rel="noreferrer" style={{ ...secondaryButton, textDecoration: 'none', display: 'block' }}>
                      Open the partly-built Doc ↗
                    </a>
                  </div>
                ) : null}
                {busy && progress ? (
                  <div style={{ fontSize: 'var(--mint-text-micro)', color: 'var(--mint-fg-subdued-title)', marginBottom: 'var(--mint-sp-2)' }}>
                    {progress}
                  </div>
                ) : null}
                <div style={{ display: 'flex', gap: 'var(--mint-sp-2)', marginTop: 'var(--mint-sp-2)' }}>
                  <button onClick={() => setStep(3)} disabled={busy} style={secondaryButton}>← Back</button>
                  <button
                    onClick={() => { void generate(); }}
                    disabled={busy}
                    style={{ ...primaryButton, flex: 1, opacity: busy ? 0.6 : 1, cursor: busy ? 'wait' : 'pointer' }}
                  >
                    {busy ? 'Generating…' : '✓ Generate statement + PDF'}
                  </button>
                </div>
                <div style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)', marginTop: 6, lineHeight: 1.45 }}>
                  Creates “{clientName || 'Client'} | Credit Card Statement {periodLabel}” in Drive,
                  exports a PDF, attaches it to {ticket.id} and writes the Ticket Log row.
                </div>
              </ExpandedCard>
            ) : (
              <FutureStub n={4} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ============================================================
// Step 2 pieces
// ============================================================

function RowTable({ rows }: { rows: StatementActivityRow[] }) {
  return (
    <div style={{ maxHeight: 260, overflowY: 'auto', border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-button)', marginBottom: 'var(--mint-sp-2)' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--mint-text-nano)' }}>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ borderTop: i ? 'var(--mint-card-stroke)' : 'none' }}>
              <td style={rowCellStyle}>{r.transDate}</td>
              <td style={rowCellStyle}>{r.postedDate}</td>
              <td style={rowCellStyle}>{r.type}</td>
              <td style={{ ...rowCellStyle, whiteSpace: 'pre-wrap' }}>{r.details}</td>
              <td style={{ ...rowCellStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.amount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Shown when the parse produced nothing usable, so the operator can see why. */
function RawTextDump({ pages }: { pages: string[][] }) {
  return (
    <details style={{ marginTop: 'var(--mint-sp-2)' }}>
      <summary style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)', cursor: 'pointer' }}>
        Show the text pdf.js extracted
      </summary>
      <pre style={{ maxHeight: 240, overflow: 'auto', fontSize: 10, lineHeight: 1.4, background: 'var(--mint-bg-subtle)', border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-button)', padding: 8, marginTop: 6, whiteSpace: 'pre-wrap' }}>
        {pages.map((lines, i) => `===== page ${i + 1} =====\n${lines.join('\n')}`).join('\n\n')}
      </pre>
    </details>
  );
}

// ============================================================
// Step 3 / 4 pieces
// ============================================================

function StaleAddress({ parsed }: { parsed: ParsedStatement }) {
  if (!parsed.nameOnStatement && !parsed.addressLines.length) return null;
  return (
    <div style={{ padding: 8, marginBottom: 'var(--mint-sp-2)', background: 'var(--mint-bg-subtle)', border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-button)' }}>
      <div style={{ fontSize: 'var(--mint-text-nano)', fontWeight: 600, color: 'var(--mint-fg-subdued-title)', marginBottom: 2 }}>
        On the statement the client received:
      </div>
      <div style={{ fontSize: 'var(--mint-text-micro)', color: 'var(--mint-fg-soft)', lineHeight: 1.5 }}>
        {[parsed.nameOnStatement, ...parsed.addressLines].filter(Boolean).map((l, i) => <div key={i}>{l}</div>)}
      </div>
    </div>
  );
}

function StatementPreview(p: {
  clientName: string; street: string; cityProvince: string; postal: string;
  fields: FieldValues; rowCount: number;
}) {
  return (
    <div style={{ padding: 'var(--mint-sp-3)', background: 'var(--mint-bg-subtle)', border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-card)', fontSize: 'var(--mint-text-micro)', lineHeight: 1.7, color: 'var(--mint-fg-strong)', whiteSpace: 'pre-wrap', marginBottom: 'var(--mint-sp-2)' }}>
      {`Credit Card Statement

${p.clientName}
${p.street}
${p.cityProvince}
${p.postal}

Credit Card Account: ${p.fields.cardMasked}
Statement Date: ${p.fields.statementDate}
Opening Date: ${p.fields.openingDate}
Closing Date: ${p.fields.closingDate}
Credit Limit: ${p.fields.creditLimit}
Minimum Payment: ${p.fields.minimumPayment}

Statement Balance: ${p.fields.statementBalance}
Payment Due Date: ${p.fields.paymentDueDate}

New Balance: ${p.fields.newBalance}
Activity: ${p.rowCount} rows`}
    </div>
  );
}

// ============================================================
// Step 5 — Success
// ============================================================

function SuccessPanel({ result, warning, ticketId, onCloseToTicket }: {
  result: CcStatementFinalizeResult; warning: string | null; ticketId: string; onCloseToTicket: () => void;
}) {
  return (
    <section style={{ background: 'var(--mint-positive-bg-soft)', border: '1px solid var(--mint-positive-fg-graphic)', borderRadius: 'var(--mint-radius-card)', padding: 'var(--mint-sp-4)', textAlign: 'center' }}>
      <div style={{ width: 48, height: 48, margin: '0 auto var(--mint-sp-2)', borderRadius: 9999, background: 'var(--mint-positive-fg-graphic)', color: '#fff', fontSize: 24, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>✓</div>
      <h3 style={{ margin: 0, fontSize: 'var(--mint-text-h-md)', color: 'var(--mint-fg-strong)', fontWeight: 700 }}>Statement generated</h3>
      <p style={{ margin: 'var(--mint-sp-2) 0 var(--mint-sp-3)', fontSize: 'var(--mint-text-meta)', color: 'var(--mint-fg-subdued-title)', lineHeight: 1.6 }}>
        {result.fileName}
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--mint-sp-2)' }}>
        <a href={result.docUrl} target="_blank" rel="noreferrer" style={{ ...primaryButton, textDecoration: 'none', display: 'block' }}>Open Doc ↗</a>
        <a href={result.pdfUrl} target="_blank" rel="noreferrer" style={{ ...secondaryButton, textDecoration: 'none', display: 'block' }}>Open PDF ↗</a>
      </div>
      {warning ? (
        <div role="alert" style={{ marginTop: 'var(--mint-sp-2)', padding: 6, background: 'var(--mint-warning-bg-soft)', border: '1px solid var(--mint-warning-fg-graphic)', borderRadius: 'var(--mint-radius-button)', fontSize: 'var(--mint-text-nano)', color: 'var(--mint-warning-fg-strong)', textAlign: 'left' }}>
          {warning}
        </div>
      ) : (
        <div style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-positive-fg-strong)', marginTop: 'var(--mint-sp-2)' }}>
          PDF attached to {ticketId} · Ticket Log row written
        </div>
      )}
      <div style={{ marginTop: 'var(--mint-sp-3)', padding: 8, background: 'var(--mint-bg-card)', border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-button)', fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-subdued-title)', textAlign: 'left', lineHeight: 1.6 }}>
        <strong>Still manual:</strong>
        <div>1. Open the Doc and eyeball the page breaks — page breaks are the one thing a script can’t verify.</div>
        <div>2. Check the disclosure page names the client’s actual card variant.</div>
        <div>3. Upload the PDF to Atlas under the client’s profile, document type “Other”.</div>
        <div>4. Send the Atlas access macro to the client.</div>
      </div>
      <button onClick={onCloseToTicket} style={{ ...secondaryButton, width: '100%', marginTop: 'var(--mint-sp-3)' }}>Close &amp; return to ticket</button>
    </section>
  );
}

// ============================================================
// Header + visual primitives
// ============================================================

function Header({ step, ticketId, onClose }: { step: StepNum; ticketId: string; onClose: () => void }) {
  return (
    <header style={{ position: 'sticky', top: 0, zIndex: 50, background: 'var(--mint-bg-card)', borderBottom: 'var(--mint-card-stroke)', padding: 'var(--mint-sp-3) var(--mint-sp-3) var(--mint-sp-2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <button onClick={onClose} title="Back to ticket" style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--mint-fg-soft)', fontSize: 16, padding: 4 }}>←</button>
        <a href={`https://wealthsimple.atlassian.net/browse/${ticketId}`} target="_blank" rel="noreferrer" style={{ color: 'var(--mint-highlight-fg-strong)', fontWeight: 700, fontSize: 'var(--mint-text-meta)', textDecoration: 'none' }}>{ticketId}</a>
        <span style={{ marginLeft: 'auto', fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)' }}>Step {Math.min(step, 4)} of 4</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 'var(--mint-text-h-md)', fontWeight: 700, color: 'var(--mint-fg-strong)' }}>Custom CC Statement</h2>
        <ProgressDots step={step} />
      </div>
    </header>
  );
}

function ProgressDots({ step }: { step: StepNum }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {[1, 2, 3, 4].map((n) => {
        const done = n < step;
        const active = n === step;
        if (done) return <span key={n} style={{ width: 14, height: 14, borderRadius: 9999, background: 'var(--mint-positive-fg-graphic)', color: '#fff', fontSize: 9, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>✓</span>;
        if (active) return <span key={n} style={{ width: 10, height: 10, borderRadius: 9999, background: 'var(--mint-fg-strong)' }} />;
        return <span key={n} style={{ width: 10, height: 10, borderRadius: 9999, border: '1.5px solid var(--mint-outline-strong)' }} />;
      })}
    </div>
  );
}

function ExpandedCard({ n, children, completed }: { n: StepNum; children: React.ReactNode; completed?: boolean }) {
  return (
    <section style={{
      background: completed ? 'var(--mint-positive-bg-soft)' : 'var(--mint-bg-card)',
      border: completed ? '1px solid var(--mint-positive-fg-graphic)' : '1px solid var(--mint-outline-strong)',
      borderRadius: 'var(--mint-radius-card)',
      padding: 'var(--mint-sp-3)',
      boxShadow: completed ? 'none' : '0 1px 3px rgba(20,17,12,0.04)',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--mint-sp-2)', marginBottom: 'var(--mint-sp-3)' }}>
        {completed ? (
          <span style={{ width: 22, height: 22, borderRadius: 9999, background: 'var(--mint-positive-fg-graphic)', color: '#fff', fontSize: 12, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>✓</span>
        ) : (
          <span style={stepNumberCircleStyle(true)}>{n}</span>
        )}
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <span style={{ fontSize: 'var(--mint-text-body)', fontWeight: 700, color: completed ? 'var(--mint-positive-fg-strong)' : 'var(--mint-fg-strong)' }}>{STEP_TITLES[n]}</span>
          {!completed ? <span style={{ fontSize: 'var(--mint-text-micro)', color: 'var(--mint-fg-soft)' }}>{STEP_SUBTITLES[n]}</span> : null}
        </div>
      </div>
      {children}
    </section>
  );
}

function FutureStub({ n }: { n: StepNum }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--mint-sp-2)', padding: '12px var(--mint-sp-3)', background: 'var(--mint-bg-subtle)', border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-card)', opacity: 0.7 }}>
      <span style={stepNumberCircleStyle(false)}>{n}</span>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <span style={{ fontSize: 'var(--mint-text-body)', fontWeight: 600, color: 'var(--mint-fg-strong)' }}>{STEP_TITLES[n]}</span>
        <span style={{ fontSize: 'var(--mint-text-micro)', color: 'var(--mint-fg-soft)' }}>Not started</span>
      </div>
    </div>
  );
}

function Summary({ lines }: { lines: string[] }) {
  return (
    <div style={{ fontSize: 'var(--mint-text-micro)', color: 'var(--mint-fg-subdued-title)', lineHeight: 1.6 }}>
      {lines.filter(Boolean).map((l, i) => <div key={i}>{l}</div>)}
    </div>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <>
      <label style={fieldLabelStyle}>{label}</label>
      <input value={value} onChange={(e) => onChange(e.target.value)} style={inputStyle} />
    </>
  );
}

function ErrorLine({ text }: { text: string }) {
  return (
    <div role="alert" style={{ marginBottom: 'var(--mint-sp-2)', padding: 6, background: 'var(--mint-negative-bg-soft)', border: '1px solid var(--mint-negative-fg-graphic)', borderRadius: 'var(--mint-radius-button)', fontSize: 'var(--mint-text-nano)', color: 'var(--mint-negative-fg-strong)', lineHeight: 1.45 }}>
      {text}
    </div>
  );
}

function WarningLine({ text }: { text: string }) {
  return (
    <div style={{ marginBottom: 6, padding: 6, background: 'var(--mint-warning-bg-soft)', border: '1px solid var(--mint-warning-fg-graphic)', borderRadius: 'var(--mint-radius-button)', fontSize: 'var(--mint-text-nano)', color: 'var(--mint-warning-fg-strong)', lineHeight: 1.45 }}>
      ⚠ {text}
    </div>
  );
}

function stepNumberCircleStyle(filled: boolean): React.CSSProperties {
  return {
    width: 22, height: 22, borderRadius: 9999, flexShrink: 0,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 12, fontWeight: 700,
    background: filled ? 'var(--mint-fg-strong)' : 'transparent',
    color: filled ? 'var(--mint-fg-inverted)' : 'var(--mint-fg-soft)',
    border: filled ? 'none' : '1.5px solid var(--mint-outline-strong)',
  };
}

// ============================================================
// helpers + styles
// ============================================================

function fieldsFromParsed(s: ParsedStatement): FieldValues {
  const out = { ...EMPTY_FIELDS };
  for (const [key] of EDITABLE_FIELDS) out[key] = s[key];
  return out;
}

/** Collapse embedded newlines/tabs — they'd become real line breaks in the Doc. */
function clean(v: string): string {
  return (v || '').replace(/\s+/g, ' ').trim();
}

/**
 * Atlas stores names however the client typed them, so they arrive all-lowercase or
 * ALL-CAPS. Re-case only those; anything already mixed-case (McDonald, van Dijk) is left
 * alone, and the field stays editable either way.
 */
function titleCaseName(raw: string): string {
  const name = clean(raw);
  if (!name) return name;
  const isUniformCase = name === name.toLowerCase() || name === name.toUpperCase();
  if (!isUniformCase) return name;
  return name.toLowerCase().replace(/(^|[\s'’-])([a-z])/g, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
}

const PROVINCE_NAMES: Record<string, string> = {
  AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick',
  NL: 'Newfoundland and Labrador', NS: 'Nova Scotia', NT: 'Northwest Territories',
  NU: 'Nunavut', ON: 'Ontario', PE: 'Prince Edward Island', QC: 'Quebec',
  SK: 'Saskatchewan', YT: 'Yukon',
};

/** The template spells the province out ("Toronto, Ontario"), so a trailing code is
 *  expanded. Anything already spelled out, or non-Canadian, is left as-is. */
function expandProvince(cityProvince: string): string {
  return cityProvince.replace(/,?\s*([A-Z]{2})$/, (whole, code: string) => {
    const name = PROVINCE_NAMES[code];
    return name ? `, ${name}` : whole;
  });
}

/** "L6M2T6" -> "L6M 2T6". The template uses the spaced form. */
function formatPostal(raw: string): string {
  const compact = clean(raw).toUpperCase().replace(/\s+/g, '');
  return /^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(compact)
    ? `${compact.slice(0, 3)} ${compact.slice(3)}`
    : clean(raw).toUpperCase();
}

const rowCellStyle: React.CSSProperties = {
  padding: '4px 6px',
  verticalAlign: 'top',
  color: 'var(--mint-fg-strong)',
};

const fieldLabelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 'var(--mint-text-nano)',
  fontWeight: 600,
  color: 'var(--mint-fg-subdued-title)',
  marginBottom: 2,
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  marginBottom: 'var(--mint-sp-2)',
  fontFamily: 'var(--mint-font-family)',
  fontSize: 'var(--mint-text-meta)',
  border: 'var(--mint-card-stroke)',
  borderRadius: 'var(--mint-radius-button)',
  background: 'var(--mint-bg-card)',
  color: 'var(--mint-fg-strong)',
  boxSizing: 'border-box',
};

const refLinkButton: React.CSSProperties = {
  flex: 1,
  padding: '8px 14px',
  borderRadius: 'var(--mint-radius-button)',
  fontWeight: 600,
  fontSize: 'var(--mint-text-meta)',
  border: 'none',
  color: '#ffffff',
  minHeight: 36,
};

const primaryButton: React.CSSProperties = {
  padding: '12px 16px',
  borderRadius: 'var(--mint-radius-button)',
  fontWeight: 700,
  fontSize: 'var(--mint-text-meta)',
  border: 'none',
  background: 'var(--mint-fg-strong)',
  color: 'var(--mint-fg-inverted)',
  cursor: 'pointer',
  textAlign: 'center',
};

const secondaryButton: React.CSSProperties = {
  padding: '10px 16px',
  borderRadius: 'var(--mint-radius-button)',
  fontWeight: 600,
  fontSize: 'var(--mint-text-meta)',
  border: 'var(--mint-card-stroke)',
  background: 'var(--mint-bg-card)',
  color: 'var(--mint-fg-strong)',
  cursor: 'pointer',
  textAlign: 'center',
};
