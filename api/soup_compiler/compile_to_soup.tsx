import { z } from "zod"
import fs from "fs"
import path from "path"
import { rimrafSync } from "rimraf"
import { file } from "bun"
import { withErrorHandling } from "lib/middlewares/with-error-handling"
/* @ts-ignore */
import bunExe from "../../bun.executable"

const jsonBody = z.object({
  typescript_filesystem: z.record(z.string()),
  target_filepath: z.string(),
  target_export: z.string(),
})

// The soup payload is wrapped in unique markers so that any other output the
// user code writes to stdout (console.log is common in development) does not
// corrupt the JSON parse.
const SOUP_JSON_START = "__TSCI_SOUP_JSON_START__"
const SOUP_JSON_END = "__TSCI_SOUP_JSON_END__"

export default withErrorHandling(async (req: Request) => {
  const { typescript_filesystem, target_export, target_filepath } =
    jsonBody.parse(await req.json())

  // Add a file that does the thing
  typescript_filesystem["__ENTRYPOINT__.tsx"] = `

import { createRoot } from "@tscircuit/react-fiber"
import { createProjectBuilder } from "@tscircuit/builder"

// TODO dynamic import so we can check for error more easily
import { ${target_export} } from "./${target_filepath}"

const projectBuilder = createProjectBuilder()
const elements = await createRoot().render(
  <${target_export} />,
  projectBuilder
)

console.log("${SOUP_JSON_START}" + JSON.stringify(elements) + "${SOUP_JSON_END}")



  `.trim()

  const unsafeUsercodeDir =
    process.env.TSCI_COMPILER_UNSAFE_USERCODE_DIR ?? "./unsafe-usercode"

  console.log(`Using unsafe usercode dir: ${unsafeUsercodeDir}`)

  fs.mkdirSync(unsafeUsercodeDir, {
    recursive: true,
  })

  let bunBin = process.env.TSCI_COMPILER_BUN_PATH

  if (!bunBin) {
    bunBin = path.resolve(unsafeUsercodeDir, "bun")
    // Setup bun in this unsafe usercode directory
    if (!fs.existsSync(bunBin)) {
      console.log(`Writing bun to path: ${bunBin}`)
      await Bun.write(file(bunBin), file(bunExe), {
        mode: 0o755,
      })
      console.log(`Chmoding bun bin file...`)
      fs.chmodSync(bunBin, 0o755)
    }
  }
  console.log(`Using bun at path: ${bunBin}`)

  // create a temporary directory representing the filesystem
  const testDir = path.join(
    unsafeUsercodeDir,
    `dump_${Math.random().toString(32).slice(2)}`
  )
  fs.mkdirSync(testDir, {
    recursive: true,
  })

  // create the files from the filesystem config
  for (const [filepath, contents] of Object.entries(typescript_filesystem)) {
    const fullPath = path.join(testDir, filepath)
    fs.mkdirSync(path.dirname(fullPath), { recursive: true })
    fs.writeFileSync(fullPath, contents)
  }

  // Install deps
  Bun.spawnSync({ cmd: [bunBin, "init"], cwd: testDir })
  Bun.spawnSync({
    cmd: [bunBin, "add", "@tscircuit/react-fiber", "@tscircuit/builder"],
    cwd: testDir,
  })
  Bun.spawnSync({ cmd: [bunBin, "install"], cwd: testDir })

  const out = await Bun.build({
    root: testDir,
    entrypoints: [`${testDir}/__ENTRYPOINT__.tsx`],
    outdir: `${testDir}/__OUTPUT__`,
    target: "bun",
  })

  if (!out.success) {
    rimrafSync(testDir)
    console.log(
      "build logs [" + out.logs.length + "]",
      JSON.stringify(out.logs)
    )
    return new Response(
      JSON.stringify({
        error: {
          error_type: "build_errors",
          build_logs: JSON.parse(JSON.stringify(out.logs)),
        },
      }),
      { status: 500 }
    )
  }

  const outFilePath = out.outputs[0].path

  const outFileRun = Bun.spawnSync({
    cmd: ["bun", outFilePath],
  })
  const outFileRunStdout = outFileRun.stdout.toString()

  console.log("stdout: ", outFileRunStdout)

  const startIdx = outFileRunStdout.lastIndexOf(SOUP_JSON_START)
  const endIdx = outFileRunStdout.lastIndexOf(SOUP_JSON_END)
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    rimrafSync(testDir)
    const stderr = outFileRun.stderr.toString()
    throw new Error(
      "Compiled user code did not print a soup payload.\n\nstderr:\n" +
        stderr.slice(-2000) +
        "\n\nstdout:\n" +
        outFileRunStdout.slice(-2000)
    )
  }

  const tscircuit_soup = JSON.parse(
    outFileRunStdout.slice(startIdx + SOUP_JSON_START.length, endIdx)
  )

  rimrafSync(testDir)

  return new Response(
    JSON.stringify({
      tscircuit_soup,
    }),
    { status: 200 }
  )
})
