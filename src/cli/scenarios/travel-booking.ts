import type { EvaluationRequest } from "../../policy/schema.js";

export interface ScenarioStep {
  description: string;
  request: Omit<EvaluationRequest, "apl_version" | "request_id" | "timestamp" | "context">;
}

export interface Scenario {
  name: string;
  description: string;
  steps: ScenarioStep[];
}

export const travelBookingScenario: Scenario = {
  name: "travel-booking",
  description:
    "Dave asks an agent to book travel to London (APL-001 Section 7)",
  steps: [
    {
      description: "Flight agent — pay $325 to British Airways (flights)",
      request: {
        policy_id: "pol_dave_london_001",
        action: {
          type: "payment",
          amount: 32500,
          currency: "USD",
          recipient: {
            id: "merchant:british-airways",
            category: "flights",
            address: "0x1234BA",
          },
          metadata: {
            description: "LHR-JFK economy return",
            reference: "BA-2174-2026-03-11",
          },
        },
      },
    },
    {
      description: "Hotel agent — pay $380 to Marriott London (hotels)",
      request: {
        policy_id: "pol_dave_london_001",
        action: {
          type: "payment",
          amount: 38000,
          currency: "USD",
          recipient: {
            id: "merchant:marriott-london",
            category: "hotels",
            address: "0x5678MA",
          },
          metadata: {
            description: "Marriott London, 3 nights",
            reference: "MAR-LON-2026-03-11",
          },
        },
      },
    },
    {
      description: "Payment $200 to nightclub (entertainment — not permitted)",
      request: {
        policy_id: "pol_dave_london_001",
        action: {
          type: "payment",
          amount: 20000,
          currency: "USD",
          recipient: {
            id: "merchant:soho-nightclub",
            category: "entertainment",
          },
          metadata: {
            description: "VIP table reservation",
          },
        },
      },
    },
    {
      description:
        "Second flight — pay $500 to Emirates (flights — over remaining budget)",
      request: {
        policy_id: "pol_dave_london_001",
        action: {
          type: "payment",
          amount: 50000,
          currency: "USD",
          recipient: {
            id: "merchant:emirates",
            category: "flights",
            address: "0x9ABCEM",
          },
          metadata: {
            description: "LHR-DXB business class",
            reference: "EK-301-2026-03-12",
          },
        },
      },
    },
  ],
};

export const scenarios: Record<string, Scenario> = {
  "travel-booking": travelBookingScenario,
};

export function getScenario(name: string): Scenario | undefined {
  return scenarios[name];
}

export function listScenarios(): string[] {
  return Object.keys(scenarios);
}
