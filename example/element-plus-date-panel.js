async (page) => {
  const input = page.locator('.el-date-editor input').first()
  await input.click()
  const day = page
    .locator('.el-picker-panel:visible .el-date-table td.available')
    .filter({ hasText: /^19$/ })
    .first()
  await day.click()
  return await input.inputValue()
}
