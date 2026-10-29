// Keeps machine-translated pages from crashing React; must run before hydration.
import { startTranslationGuard } from "./lib/translated-page";
// Browser errors to StatOSS when NEXT_PUBLIC_STATOSS_DSN was set at build time.
import { startBrowserObservability } from "./lib/observability-browser";

startTranslationGuard();
startBrowserObservability();
