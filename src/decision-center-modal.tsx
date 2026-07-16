import { Check, Hand, X } from "lucide-react";
import type { ApprovalRequest } from "./model";
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
            No pending decisions. New approvals and mediator questions will
            appear here.
          </p>
        )}
        <div className="decision-center-list">
          {pending.map((request) => (
            <section className="decision-card" key={request.id}>
              <span>APPROVAL · {request.nodeId}</span>
              <h3>{request.title}</h3>
              <p>{request.detail}</p>
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
              <span>QUESTION · COMPANY MEDIATOR</span>
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
                    onChange={(event) => onFreeTextChange(event.target.value)}
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
