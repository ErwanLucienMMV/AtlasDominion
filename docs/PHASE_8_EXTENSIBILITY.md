# Phase 8 — extensibility verification

The initial Phase 8 implementation verified the existing generic application interfaces without deploying another game or modifying core application source. Its subsequent adversarial review identified a hung-stats availability defect, corrected in the observer as documented below and in [validation evidence](PHASE_8_VALIDATION.md). `tests/fixtures/phase8/instance.json` describes the invented `nebula-sandbox` game type. It is a synthetic fixture, not an image recommendation or deployable game definition; its checked-in allowlists deny access.

## Reproduce

With Node 20 or newer and the pinned dependencies installed:

```sh
node scripts/validate-registry.mjs tests/fixtures/phase8/instance.json tests/fixtures/instance.json
node --test tests/phase8-extensibility.test.mjs tests/phase8-scale.test.mjs
npm test
git diff --check
```

The tests use in-memory pre-provisioned Docker containers, local ephemeral authenticated NestJS HTTP listeners, stubbed Discord webhook delivery and new temporary backup directories. They never connect to the Docker daemon or Discord. Temporary archives and source markers remain available for inspection. No production files, services, networks, volumes or firewall settings are changed.

## Acceptance mapping

| Requirement in PLAN.md | Executable evidence |
|---|---|
| Add an unknown game manifest | Schema validation accepts the synthetic manifest alongside the existing Minecraft fixture; generic adapters are reused. |
| Recognize its pre-provisioned container | Real `DockerAccess` verifies mock inspection identity, labels, ports, isolation and memory limits. Lifecycle calls must use the pinned container ID. |
| API and Discord discovery | Authenticated HTTP list/status and Discord autocomplete discover the instance; unauthorized and unknown status requests fail. |
| Generic lifecycle | Discord completion starts and stops the mock through the real private HTTP controller and polls its operation. Readiness remains `unverified`. |
| Correct metrics | Observer resource sampling and authenticated metrics expose the synthetic instance and game type labels. |
| Backup resolves | Existing worker config resolves the instance and approved volume; the worker archives synthetic save bytes, verifies an isolated restore and refuses overwrite of the restored directory. |
| No core modification needed for a new game | The synthetic game uses existing generic interfaces. The later sampling correction is generic and does not add game-specific behavior. |
| Dozens of instances | A deterministic 50-instance fleet spans five invented game types and distinct containers/ports. |
| Listing | Seven-item HTTP pagination returns all 49 authorized instances exactly once; Discord reaches the last page, caps autocomplete at 25 and omits the denied instance. Discord list supplies a continuation cursor. |
| Concurrency limits | Fifty simultaneous HTTP starts compete for three slots, with separate memory-limited and CPU-limited cases. Exactly three succeed; 47 receive `RESOURCE_EXHAUSTED`. Same-instance operations conflict. Explicitly stopping one instance frees capacity for another; no automatic eviction occurs. |
| Polling performance | Twenty overlapping refresh calls coalesce into one pass: 100 inspections and 50 resource requests for 50 running containers. Elapsed mock time is printed as a diagnostic. |
| Metrics cardinality | The sampled fleet now emits exactly 761 series: eleven global series plus 15 per instance, including the two sampling-health gauges added by the corrective change. Repeated polls retain identical series keys. Operation outcomes add fixed action/outcome series when operations occur. |
| Error isolation | A missing container appears as `missing`; a failed resource sample removes its stale sample while 48 others remain available. Unrelated status still works. Engine failure closes lifecycle admission; clearing the failure restores readiness and all samples. |
| Registry validation | Invalid final entries in a 50-instance set reject duplicate IDs, duplicate container ownership, conflicting ports, unknown adapters, identity-label mismatch and arbitrary execution fields. Backup configuration resolves all 50 jobs and rejects unknown IDs, duplicates and overlapping paths. |

## Interpretation and limits

These checks establish configuration-based reuse of the existing generic capabilities. They do not establish compatibility with an actual unknown game, live Discord signatures, real Docker concurrency or hardware capacity. Prior phase security and signed-interaction tests remain part of the full suite.

Mock timing is diagnostic rather than a real-host performance threshold. The observer performs sequential sampling with a five-second deadline per sampling inspection-plus-stats read; timed-out reads no longer block later samples indefinitely. Overlapping polls coalesce, and an unresolved sampling request is not repeated until it settles. Separate sampling readiness/freshness gauges expose degradation while preserving lifecycle health semantics. Reconciliation and listing requests remain outside this sampling deadline. Multiple slow instances can still lengthen a pass. Production latency, daemon timeout behavior and capacity tuning remain Phase 9 validation work. Listing currently performs one inspection per returned instance, and autocomplete may inspect multiple pages; passing 50 mock instances does not prove a particular Discord deadline on a loaded host.

Missing containers and resource-sample failures have local handling. Other inspection failures fail a list request or reconciliation closed; the tests do not claim that every Docker error permits partial API results. This preserves the existing safety behavior without disguising infrastructure failures.

Do not put this fixture into a production registry. For real onboarding follow [ADDING_A_GAME.md](ADDING_A_GAME.md), review the image and persistent storage, provision only with approval, configure explicit access policies, and perform gameplay/save/recovery acceptance. Generic `docker-stop` and stopped-volume backup do not prove a particular game saved consistently. No additional real game is deployed by Phase 8.
