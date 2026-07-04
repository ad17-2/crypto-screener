from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class RunPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    run_id: str
    generated_at: str
    rows: list[dict[str, Any]]
    market_context: dict[str, Any] = Field(default_factory=dict)
    provider_status: dict[str, Any] = Field(default_factory=dict)
    factor_weights: dict[str, Any] = Field(default_factory=dict)
    regime: dict[str, Any] = Field(default_factory=dict)

    def to_runtime_dict(self) -> dict[str, Any]:
        return self.model_dump(mode="json")
