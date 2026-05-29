import mammoth from 'mammoth';
import minioClient from '@/lib/storage';

async function downloadFileFromMinio(bucket: string, key: string): Promise<Buffer> {
  const stream = await minioClient.getObject(bucket, key);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function extractTextFromFile(
  bucket: string,
  key: string,
  mimeType: string,
  filename: string,
): Promise<string> {
  try {
    const buffer = await downloadFileFromMinio(bucket, key);

    let text = '';

    if (mimeType === 'application/pdf' || filename.endsWith('.pdf')) {
      try {
        const pdf = (await import('pdf-parse')).default;
        const data = await pdf(buffer);
        text = data.text || '';
      } catch (pdfError) {
        throw new Error(
          `Failed to parse PDF: ${pdfError instanceof Error ? pdfError.message : 'Unknown error'}`,
        );
      }
    } else if (
      mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      filename.endsWith('.docx')
    ) {
      try {
        const result = await mammoth.extractRawText({ buffer });
        text = result.value || '';
      } catch (docxError) {
        throw new Error(
          `Failed to parse DOCX: ${
            docxError instanceof Error ? docxError.message : 'Unknown error'
          }`,
        );
      }
    } else if (
      filename.endsWith('.md') ||
      filename.endsWith('.txt') ||
      mimeType.startsWith('text/')
    ) {
      try {
        text = buffer.toString('utf-8');
      } catch (textError) {
        throw new Error(
          `Failed to parse text file: ${
            textError instanceof Error ? textError.message : 'Unknown error'
          }`,
        );
      }
    } else {
      throw new Error(`Unsupported file type: ${mimeType} (${filename})`);
    }

    return text.replace(/\s+/g, ' ').trim();
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`File parsing failed: ${String(error)}`);
  }
}
