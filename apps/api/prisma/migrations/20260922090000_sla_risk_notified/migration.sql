-- Prediction of a breach before it happens (roadmap #8): when the owner was told, and the
-- probability that prompted it — kept so the prediction can be judged after the fact.
ALTER TABLE "sla_clocks" ADD COLUMN     "riskNotifiedAt" TIMESTAMP(3),
ADD COLUMN     "riskProbability" DECIMAL(4,3);
