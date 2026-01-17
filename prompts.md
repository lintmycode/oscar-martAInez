# Testing Prompts in ChatGPT UI

Before using the API, test these prompts in ChatGPT to refine them at zero cost.

## Invoice Extraction Prompt

### How to test

1. Go to [chat.openai.com](https://chat.openai.com)
2. Upload a PDF or image from `inputs/digital/` or `inputs/paper/`
3. Copy and paste this prompt:

### Prompt

```
Extract invoice data and return ONLY valid JSON (no markdown, no explanation).

Required fields:
- vendor: supplier/company name
- invoiceNumber: invoice/receipt number (string)
- date: invoice date in dd/mm/yyyy format
- amount: total amount as number (no currency symbol)

If a field is not found, use null.

Example:
{"vendor":"ACME Corp","invoiceNumber":"INV-123","date":"15/10/2025","amount":39.99}
```

### Expected output format

```json
{"vendor":"Amazon","invoiceNumber":"123-4567890-1234567","date":"18/09/2025","amount":10.07}
```

### What to check

- ✅ JSON is valid (no markdown backticks)
- ✅ All 4 fields present
- ✅ Date in dd/mm/yyyy format
- ✅ Amount is a number without € symbol
- ✅ Vendor name is clean and readable

### Common issues and fixes

| Issue | Fix |
|-------|-----|
| JSON wrapped in ```json...``` | Add "no markdown" to prompt |
| Date in wrong format | Specify "dd/mm/yyyy" more explicitly |
| Amount includes "€" | Add "remove currency symbol" |
| Vendor too verbose | May need post-processing in code |

---

## Cost Estimation

Using `gpt-4o-mini`:

| Task | Tokens (approx) | Cost per call |
|------|-----------------|---------------|
| PDF text extraction | 500-800 | $0.0003 |
| Image OCR | 1,000-1,500 | $0.0009 |

**Monthly example** (10 PDFs, 5 images, 30 transactions):
- Total: ~10,500 tokens
- Cost: **$0.006** (less than 1 cent)

---

## Switching from UI to API

Once your prompts work well in ChatGPT:

1. ✅ Prompts are already in the code ([lib/invoice-extractor.js](lib/invoice-extractor.js:68))
2. ✅ Just add `OPENAI_API_KEY` to `.env`
3. ✅ Run `node index.js`

No code changes needed!

---

## Advanced: Batch Processing (Future Enhancement)

To reduce costs further, send multiple invoices in one request:

```
Extract invoice data from these images. Return a JSON array.

Required fields per invoice:
- vendor: supplier/company name
- invoiceNumber: invoice/receipt number
- date: dd/mm/yyyy
- amount: number

Example output:
[
  {"vendor":"ACME","invoiceNumber":"INV-1","date":"01/10/2025","amount":39.99},
  {"vendor":"XYZ","invoiceNumber":"INV-2","date":"05/10/2025","amount":120.00}
]
```

Upload 3 images at once to test. Would require code changes to implement.

---

## Troubleshooting

If extraction fails, use this diagnostic prompt:

```
What text can you see in this invoice? List:
1. Company/vendor name
2. Date
3. Total amount
4. Invoice number (if any)
```

This helps debug extraction issues without JSON formatting.
