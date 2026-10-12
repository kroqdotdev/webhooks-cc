// Browser errors to StatOSS when NEXT_PUBLIC_STATOSS_DSN was set at build time.
import { startBrowserObservability } from "./lib/observability-browser";

startBrowserObservability();
