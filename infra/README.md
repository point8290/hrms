# Infrastructure

## What is actually here

`terraform/` provisions the minimum a production deployment needs and nothing more. It is
written to be applied, not to be admired: every resource in it is referenced by the
application, and there are no placeholders that would fail on first `apply`.

| Area | Status | Where |
| --- | --- | --- |
| VPC, subnets, NAT, security groups | **implemented** | `terraform/network.tf` |
| RDS PostgreSQL 16, encrypted, private | **implemented** | `terraform/database.tf` |
| ElastiCache Redis, encrypted in transit | **implemented** | `terraform/cache.tf` |
| SQS queues + dead letter queues + redrive | **implemented** | `terraform/queues.tf` |
| S3 document bucket, KMS, versioned, private | **implemented** | `terraform/storage.tf` |
| Secrets Manager entries + rotation-ready shape | **implemented** | `terraform/secrets.tf` |
| ECS Fargate: api, worker, scheduler | **implemented** | `terraform/ecs.tf` |
| ALB + TLS listener + health checks | **implemented** | `terraform/loadbalancer.tf` |
| IAM task roles, least privilege | **implemented** | `terraform/iam.tf` |
| CloudWatch log groups + retention | **implemented** | `terraform/observability.tf` |
| SES identity for outbound mail | **implemented** | `terraform/mail.tf` |
| Calculation engines (Python) on ECS | **planned** | see below |
| WAF, Shield, GuardDuty | **planned** | — |
| Cross-region replica / DR | **planned** | — |
| Blue-green or canary deploys | **planned** | — |
| Autoscaling policies | **planned** | — |
| CDN for the web app | **planned** | — |

### Deliberately planned, not built

* **Python engines on ECS.** They run as containers identical in shape to the worker, and
  the task definition would be a copy of `ecs.tf`'s worker with a different image and queue.
  Left out until the queue names and resource sizing are settled by a real load test, rather
  than guessed and then inherited.
* **Autoscaling.** Scaling on CPU is almost always wrong for this workload: the API is
  latency-bound on the database and the worker is bound by SQS depth. The right policy is
  `ApproximateNumberOfMessagesVisible` per queue, with a floor of one scheduler. Writing it
  before there is a production traffic shape would encode a guess as infrastructure.
* **WAF.** Valuable, but it is configuration of rules against real traffic, not a resource
  to be declared once. Rate limiting and validation are in the application today.

## Deployment shape

Three ECS services from two images:

```
ALB ──▶ api        (N replicas, public via ALB, private subnets)
        worker     (N replicas, WORKER_ROLES=consumer,publisher,notifications)
        scheduler  (1–2 replicas, WORKER_ROLES=scheduler)
```

The scheduler is a separate service running the *same image* as the worker. It is split not
because the code requires it — every loop is safe to run concurrently — but because job
execution and scheduling have opposite scaling pressures. A worker fleet saturated by a
payroll run must not be the reason a tenant's attendance stops closing. Running two
scheduler replicas is supported and is the recommended setting: claims use
`FOR UPDATE SKIP LOCKED`, so a second replica is redundancy, not a race (ADR-010).

## Credentials

No credential appears in Terraform state as plaintext, in a task definition, or in an
environment variable:

* Database, JWT and field-encryption secrets live in Secrets Manager and are injected by
  ECS as `secrets`, not `environment`. They are never visible to `aws ecs describe-tasks`.
* AWS access is entirely via task roles. The application never constructs an SQS or S3
  client with keys — the SDK's default provider chain resolves the role.
* `terraform/secrets.tf` creates the secret *containers*; the values are set out of band
  (`aws secretsmanager put-secret-value`) so they never enter the repository or the plan.

## Applying

```bash
cd infra/terraform
terraform init
terraform plan  -var-file=env/production.tfvars
terraform apply -var-file=env/production.tfvars
```

Migrations are **not** run by Terraform. They run as a one-off ECS task from the same image,
before the new service revision is deployed:

```bash
aws ecs run-task --cluster hrms-production --task-definition hrms-migrate \
  --launch-type FARGATE --network-configuration "$(cat env/network-config.json)"
```

That ordering is deliberate. A migration that runs as part of the service start-up races
every other replica starting at the same time, and a failed migration would then present as
a crash loop instead of a failed deploy step.
