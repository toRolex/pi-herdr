export const meta = { name: 't12-live-aggregate', description: 'prove aggregate does not republish a child final' }
const child = await agent('WORKFLOW CHILD SENTINEL', { label: 't12-wf-child', model: 't12-demo/deterministic' })
return { childCompleted: child.includes('T12_FINAL WORKFLOW CHILD SENTINEL') }