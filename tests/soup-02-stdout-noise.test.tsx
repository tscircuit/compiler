import { expect, test } from "bun:test"

test("[soup-02] compile_to_soup tolerates console output in user code", async () => {
  const { axios } = global.fixture

  const res = await axios.post("/soup_compiler/compile_to_soup", {
    typescript_filesystem: {
      "test.tsx": `
      console.log("module-level debug noise")

      export const Test = () => {
        console.log("render-time debug noise")
        return <resistor resistance="10kohm" name="R1" />
      }
      `,
    },
    target_filepath: "test.tsx",
    target_export: "Test",
  })

  expect(res.status).toBe(200)
  expect(res.data.tscircuit_soup).toBeArray()
  expect(
    res.data.tscircuit_soup.some((e: any) => e.type === "source_component")
  ).toBe(true)
})
