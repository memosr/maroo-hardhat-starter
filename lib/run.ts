/**
 * Run a script body and report failures as one readable line instead of a
 * stack trace. Expected outcomes (wrong network, a PCL policy rejection,
 * fee cap reached) are normal results, not crashes. Set MAROO_DEBUG=1 to
 * print the full stack. The process still exits with code 1 on failure.
 */
export async function runScript(main: () => Promise<void>): Promise<void> {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\n✖ ${message}`);
    if (process.env.MAROO_DEBUG === "1" && error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    process.exitCode = 1;
  }
}
