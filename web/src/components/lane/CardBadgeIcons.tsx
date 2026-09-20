function BlockedIcon() {
  return (
    <svg className="badge-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.4" />
      <line x1="4.2" y1="4.2" x2="11.8" y2="11.8" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function UnblocksIcon() {
  return (
    <svg className="badge-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect
        x="4"
        y="7.25"
        width="8"
        height="5.5"
        rx="1.3"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path
        d="M6 7.25V5.5a2 2 0 0 1 3.6-1.2"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function DeferIcon() {
  return (
    <svg className="badge-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect
        x="2.5"
        y="3.5"
        width="11"
        height="10"
        rx="1.6"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <line x1="2.5" y1="6.5" x2="13.5" y2="6.5" stroke="currentColor" strokeWidth="1.4" />
      <line x1="5.5" y1="2" x2="5.5" y2="4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <line x1="10.5" y1="2" x2="10.5" y2="4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function StalledIcon() {
  return (
    <svg className="badge-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 2.5 13.5 12.5H2.5L8 2.5Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <line x1="8" y1="6.5" x2="8" y2="9.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="8" cy="11.25" r="0.75" fill="currentColor" />
    </svg>
  );
}

function PendingDecisionIcon() {
  return (
    <svg className="badge-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3.5 3.5h9a1.2 1.2 0 0 1 1.2 1.2v5.1a1.2 1.2 0 0 1-1.2 1.2H6.2L3.8 13.1V4.7a1.2 1.2 0 0 1 1.2-1.2Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <circle cx="6.2" cy="7.2" r="0.7" fill="currentColor" />
      <circle cx="8" cy="7.2" r="0.7" fill="currentColor" />
      <circle cx="9.8" cy="7.2" r="0.7" fill="currentColor" />
    </svg>
  );
}

export {
  BlockedIcon,
  UnblocksIcon,
  DeferIcon,
  StalledIcon,
  PendingDecisionIcon,
};
