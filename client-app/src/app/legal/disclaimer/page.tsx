export default function DisclaimerPage() {
  return (
    <div className="min-h-screen bg-app px-4 py-10 text-ink sm:px-6">
      <div className="mx-auto max-w-3xl space-y-6">
        <h1 className="text-2xl font-extrabold tracking-tight text-ink sm:text-3xl">
          Risk Disclaimer
        </h1>
        <div className="tp-card p-6 sm:p-8">
          <div className="tp-banner tp-banner-warning mb-6">
            <p className="font-semibold">
              Trading carries a high level of risk and may not be suitable for
              every investor.
            </p>
          </div>
          <p className="text-sm leading-relaxed text-ink-muted sm:text-base">
            Trading financial instruments involves significant risk. Our AI
            predictions and signals are for educational purposes only.
          </p>
        </div>
      </div>
    </div>
  );
}
