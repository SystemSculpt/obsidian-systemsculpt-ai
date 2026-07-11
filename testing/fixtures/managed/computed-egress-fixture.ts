const marker = "SYSTEMSCULPT_COMPUTED_EGRESS_FIXTURE";
const transport = fetch;

export async function runComputedEgressFixture(): Promise<void> {
  const scheme = "https";
  const host = ["computed-egress", "invalid"].join(".");
  const destination = `${scheme}://${host}/path`;
  void marker;
  await transport(destination);
}
