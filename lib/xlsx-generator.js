import ExcelJS from 'exceljs';

/**
 * Generate XLSX file with company and personal account sheets
 */
export class XlsxGenerator {
  /**
   * Create workbook with formatted sheets
   */
  async generate(companyRows, personalRows, outputPath) {
    const workbook = new ExcelJS.Workbook();

    // Sheet 1: Company Account
    this.createSheet(
      workbook,
      'company account',
      companyRows,
      false // No total row for company
    );

    // Sheet 2: Personal Account
    this.createSheet(
      workbook,
      'personal account',
      personalRows,
      true // With total row
    );

    await workbook.xlsx.writeFile(outputPath);
    console.log(`\n✅ Spreadsheet saved: ${outputPath}`);
  }

  /**
   * Create a single sheet with data
   */
  createSheet(workbook, name, rows, withTotal) {
    const sheet = workbook.addWorksheet(name);

    // Define columns (Portuguese names as required)
    sheet.columns = [
      { header: 'Data', key: 'date', width: 12 },
      { header: 'Fornecedor', key: 'vendor', width: 35 },
      { header: 'Valor', key: 'amount', width: 12 },
      { header: 'Factura', key: 'invoice', width: 20 },
      { header: 'Observações', key: 'notes', width: 40 },
    ];

    // Style header row
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E0E0' },
    };

    // Add data rows
    rows.forEach(row => {
      sheet.addRow({
        date: row.date,
        vendor: row.vendor,
        amount: row.amount,
        invoice: row.invoice,
        notes: row.notes,
      });
    });

    // Format amount column as currency
    const amountCol = sheet.getColumn('amount');
    amountCol.numFmt = '#,##0.00 "€"';
    amountCol.alignment = { horizontal: 'right' };

    // Highlight rows missing invoice in company sheet
    if (name === 'company account') {
      sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return; // Skip header

        const invoiceCell = row.getCell('invoice');
        if (!invoiceCell.value || invoiceCell.value.toString().trim() === '') {
          row.eachCell(cell => {
            cell.fill = {
              type: 'pattern',
              pattern: 'solid',
              fgColor: { argb: 'FFFFF4CC' }, // Light yellow
            };
          });
        }
      });
    }

    // Add TOTAL row if requested
    if (withTotal && rows.length > 0) {
      const totalRow = sheet.addRow({
        date: '',
        vendor: 'TOTAL',
        amount: { formula: `SUM(C2:C${rows.length + 1})` },
        invoice: '',
        notes: '',
      });

      totalRow.font = { bold: true };
      totalRow.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFD0D0D0' },
      };
    }

    // Freeze header row
    sheet.views = [
      { state: 'frozen', ySplit: 1 },
    ];
  }

  /**
   * Also export as CSV for debugging
   */
  async exportCsv(companyRows, personalRows, outputDir) {
    const companyCsv = this.toCsv(companyRows);
    const personalCsv = this.toCsv(personalRows);

    const fs = await import('fs/promises');
    const path = await import('path');

    await fs.writeFile(
      path.join(outputDir, 'company-account.csv'),
      companyCsv
    );
    await fs.writeFile(
      path.join(outputDir, 'personal-account.csv'),
      personalCsv
    );

    console.log('📄 Debug CSVs exported');
  }

  /**
   * Convert rows to CSV format
   */
  toCsv(rows) {
    const header = 'Data;Fornecedor;Valor;Factura;Observações\n';
    const lines = rows.map(row =>
      [
        row.date,
        row.vendor,
        row.amount.toFixed(2),
        row.invoice,
        row.notes,
      ].join(';')
    );

    return header + lines.join('\n');
  }
}
