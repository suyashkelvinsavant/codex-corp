import { Check, FileOutput, Hand, Terminal, ShieldQuestion, X } from "lucide-react";
import type { CSSProperties } from "react";
import type { ApprovalRequest, StructuredApproval } from "./model";
import type { MediatorQuestion } from "./mediator-ui";

export type DecisionCenterModalProps = {
  approvals: ApprovalRequest[];
  question: MediatorQuestion | null;
  selectedOptions: string[];
  freeText: string;
  onFreeTextChange: (value: string) => void;
  onToggleOption: (id: string, multiSelect: boolean) => void;
  onDecideApproval: (request: ApprovalRequest, approved: boolean) => void;
  onResolveQuestion: (cancel: boolean) => void;
  onClose: () => void;
};

export function DecisionCenterModal({
  approvals,
  question,
  selectedOptions,
  freeText,
  onFreeTextChange,
  onToggleOption,
  onDecideApproval,
  onResolveQuestion,
  onClose,
}: DecisionCenterModalProps) {
  const pending = approvals.filter((item) => item.status === "pending");
  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="decision-center-title"
    >
      <div className="approval-modal decision-center-modal">
        <button
          className="modal-close"
          onClick={onClose}
          aria-label="Close approvals"
        >
          <X size={16} />
        </button>
        <div className="approval-icon">
          <Hand size={20} />
        </div>
        <span>OPERATOR DECISIONS</span>
        <h2 id="decision-center-title">Approvals & questions</h2>
        {!pending.length && !question && (
          <p className="decision-center-empty">
            No pending decisions. New approvals and Byte questions will
            appear here.
          </p>
        )}
        <div className="decision-center-list">
          {pending.map((request) => (
            <section className="decision-card" key={request.id}>
              <span>APPROVAL · {request.nodeId}</span>
              <h3>{request.title}</h3>
              {request.structured && request.structured.kind !== "unknown" ? (
                <>
                  <StructuredApprovalContent structured={request.structured} />
                  <details className="decision-raw-payload">
                    <summary>Raw request payload</summary>
                    <pre className="decision-detail-raw">{request.detail}</pre>
                  </details>
                </>
              ) : (
                <p className="decision-detail-raw">{request.detail}</p>
              )}
              <small>{request.risk}</small>
              <div className="modal-actions">
                <button onClick={() => onDecideApproval(request, false)}>
                  Decline
                </button>
                <button
                  className="primary"
                  onClick={() => onDecideApproval(request, true)}
                >
                  <Check size={14} /> Approve once
                </button>
              </div>
            </section>
          ))}
          {question && (
            <section className="decision-card mediator-question-modal">
              <span>QUESTION · BYTE</span>
              <h3>{question.title}</h3>
              <p>{question.body}</p>
              {!!question.options?.length && (
                <div className="mediator-question-options">
                  {question.options.map((option) => {
                    const selected = selectedOptions.includes(option.id);
                    return (
                      <button
                        key={option.id}
                        type="button"
                        className={
                          selected ? "option-chip selected" : "option-chip"
                        }
                        onClick={() =>
                          onToggleOption(option.id, !!question.multiSelect)
                        }
                      >
                        <b>{option.label}</b>
                        {option.description ? (
                          <small>{option.description}</small>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              )}
              {(question.allowFreeText !== false ||
                !question.options?.length) &&
                !question.optionsOnly && (
                  <textarea
                    className="mediator-question-text"
                    rows={3}
                    placeholder={
                      question.placeholder ?? "Optional free-text answer…"
                    }
                    value={freeText}
                    aria-label={question.secret ? "Secret answer" : "Free-text answer"}
                    onChange={(event) => onFreeTextChange(event.target.value)}
                    style={question.secret ? ({ WebkitTextSecurity: "disc" } as CSSProperties) : undefined}
                  />
                )}
              <div className="modal-actions">
                <button type="button" onClick={() => onResolveQuestion(true)}>
                  Cancel question
                </button>
                <button
                  type="button"
                  className="primary"
                  onClick={() => onResolveQuestion(false)}
                >
                  Submit answer
                </button>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function StructuredApprovalContent({ structured }: { structured: StructuredApproval }) {
  switch (structured.kind) {
    case "fileChange":
      return (
        <div className="structured-approval structured-file-change">
          {structured.reason && (
            <p className="structured-reason">{structured.reason}</p>
          )}
          <div className="structured-file-list">
            {structured.files.map((file) => (
              <div key={file.path} className="structured-file-item">
                <FileOutput size={13} />
                <span className={`structured-file-type ${file.type}`}>{file.type}</span>
                <code className="structured-file-path">{file.path}</code>
              </div>
            ))}
          </div>
          {structured.grantRoot && (
            <p className="structured-grant-root">Grant root: <code>{structured.grantRoot}</code></p>
          )}
        </div>
      );
    case "execCommand":
      return (
        <div className="structured-approval structured-exec-command">
          <div className="structured-command-row">
            <Terminal size={13} />
            <code className="structured-command">{structured.command}</code>
          </div>
          <p className="structured-cwd">in <code>{structured.cwd}</code></p>
          {structured.reason && (
            <p className="structured-reason">{structured.reason}</p>
          )}
          {structured.commandActions?.map((pc, i) => (
            <div key={i} className="structured-parsed-cmd">
              <small>{pc.type}{pc.name ? ` · ${pc.name}` : ""}{pc.path ? ` → ${pc.path}` : ""}</small>
            </div>
          ))}
          {structured.additionalPermissions != null && (
            <pre className="decision-detail-raw">{JSON.stringify(structured.additionalPermissions, null, 2)}</pre>
          )}
        </div>
      );
    case "permissions":
      return (
        <div className="structured-approval structured-permissions">
          <div className="structured-command-row">
            <ShieldQuestion size={13} />
            <span>Permission profile request</span>
          </div>
          {structured.reason && (
            <p className="structured-reason">{structured.reason}</p>
          )}
          {structured.permissions != null && (
            <pre className="decision-detail-raw">{JSON.stringify(structured.permissions, null, 2)}</pre>
          )}
        </div>
      );
    case "commandExecution":
      return (
        <div className="structured-approval structured-exec-command">
          {structured.command && (
            <div className="structured-command-row">
              <Terminal size={13} />
              <code className="structured-command">{structured.command}</code>
            </div>
          )}
          {structured.cwd && <p className="structured-cwd">in <code>{structured.cwd}</code></p>}
          {structured.reason && <p className="structured-reason">{structured.reason}</p>}
        </div>
      );
    default:
      return null;
  }
}
