import ExcelJS from 'exceljs';

/**
 * Generate XLSX file with company and personal account sheets
 */
export class XlsxGenerator {
  /**
   * Create workbook with formatted sheets
   */
  async generate(companyRows, personalRows, outputPath, options = {}) {
    const { personalRemain = 0 } = options;
    const workbook = new ExcelJS.Workbook();

    // Sheet 1: Company Account (no TOTAL)
    this.createSheet(
      workbook,
      'company account',
      companyRows,
      { withTotal: false }
    );

    // Sheet 2: Personal Account (with TOTAL)
    this.createSheet(
      workbook,
      'personal account',
      personalRows,
      { withTotal: true, personalRemain }
    );

    await workbook.xlsx.writeFile(outputPath);
    console.log(`\n✅ Spreadsheet saved: ${outputPath}`);
  }

  /**
   * Create a single sheet with data
   */
  createSheet(workbook, name, rows, options = {}) {
    const { withTotal = false, personalRemain = 0 } = options;
    const sheet = workbook.addWorksheet(name);

    // Define columns (Portuguese names as required)
    sheet.columns = [
      { header: 'Data', key: 'date', width: 12 },
      { header: 'Fornecedor', key: 'vendor', width: 35 },
      { header: 'Valor', key: 'amount', width: 12 },
      { header: 'Factura', key: 'invoice', width: 20 },
      { header: 'Ficheiro', key: 'file', width: 30 },
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
        file: row.file,
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

    const styleSummaryRow = (row) => {
      row.font = { bold: true };
      row.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFD0D0D0' },
      };
    };

    // Add summary rows when enabled
    if (withTotal) {
      const dataEndRow = rows.length > 0 ? rows.length + 1 : 2;
      const totalRange = `C2:C${dataEndRow}`;

      if (name === 'personal account') {
        const totalCorrenteRow = sheet.addRow({
          date: '',
          vendor: 'TOTAL CORRENTE',
          amount: { formula: `SUM(${totalRange})` },
          invoice: '',
          notes: '',
        });
        styleSummaryRow(totalCorrenteRow);

        const totalRemanescenteRow = sheet.addRow({
          date: '',
          vendor: 'TOTAL REMINESCENTE',
          amount: Number.isFinite(personalRemain) ? personalRemain : 0,
          invoice: '',
          notes: '',
        });
        styleSummaryRow(totalRemanescenteRow);

        const totalRow = sheet.addRow({
          date: '',
          vendor: 'TOTAL',
          amount: { formula: `C${totalCorrenteRow.number}+C${totalRemanescenteRow.number}` },
          invoice: '',
          notes: '',
        });
        styleSummaryRow(totalRow);
      } else if (rows.length > 0) {
        const totalRow = sheet.addRow({
          date: '',
          vendor: 'TOTAL',
          amount: { formula: `SUM(${totalRange})` },
          invoice: '',
          notes: '',
        });
        styleSummaryRow(totalRow);
      }
    }

    // Freeze header row
    sheet.views = [
      { state: 'frozen', ySplit: 1 },
    ];

    // Enforce Arial 10pt across the sheet (preserve bold/other font flags)
    sheet.eachRow({ includeEmpty: true }, row => {
      row.eachCell({ includeEmpty: true }, cell => {
        cell.font = { ...(cell.font || {}), name: 'Arial', size: 10 };
        cell.border = {
          ...(cell.border || {}),
          bottom: { style: 'thin', color: { argb: 'FF999999' } },
        };
      });
    });
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
    const header = 'Data;Fornecedor;Valor;Factura;Ficheiro;Observações\n';
    const lines = rows.map(row =>
      [
        row.date,
        row.vendor,
        row.amount.toFixed(2),
        row.invoice,
        row.file,
        row.notes,
      ].join(';')
    );

    return header + lines.join('\n');
  }
}
