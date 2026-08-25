"""OTel export configuration for the MAF handoff bridge, pointed at a Phoenix collector.

Configured entirely from environment variables so the same image works standalone (no
collector, spans just aren't exported) and wired into the docker-compose dev environment
(WS5), which sets `PHOENIX_COLLECTOR_ENDPOINT` to point at the sibling Phoenix container.
Phoenix remains a passive telemetry consumer only — nothing here calls back into the app.
"""

from __future__ import annotations

import os

_configured = False


def configure_telemetry() -> None:
    """Idempotently wire up `openinference-instrumentation-agent-framework` if a collector
    endpoint is configured. No-ops (does not raise) when the env var is unset, so running the
    server standalone for `curl localhost:PORT/agents/manifest` never depends on Phoenix.
    """

    global _configured
    if _configured:
        return
    _configured = True

    endpoint = os.environ.get("PHOENIX_COLLECTOR_ENDPOINT")
    if not endpoint:
        return

    from openinference.instrumentation.agent_framework import AgentFrameworkInstrumentor
    from opentelemetry import trace
    from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
    from opentelemetry.sdk.resources import SERVICE_NAME, Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor

    resource = Resource.create({SERVICE_NAME: os.environ.get("OTEL_SERVICE_NAME", "remote-maf-handoff-bridge")})
    provider = TracerProvider(resource=resource)
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=endpoint)))
    trace.set_tracer_provider(provider)

    AgentFrameworkInstrumentor().instrument(tracer_provider=provider)
