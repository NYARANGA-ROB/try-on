import OpenAI, { toFile } from "openai";
import { useCategories } from '../contexts/CategoriesContext';
import TokenUsageService from './TokenUsageService';

/* ---------------------------------------------------------- *
 *  Helpers                                                   *
 * ---------------------------------------------------------- */

/** Redimensionne un `File` image ≤ 512 px (proportions conservées). */
async function resizeFileTo512(file: File): Promise<File> {
  // Charge l'image dans un bitmap
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(512 / bitmap.width, 512 / bitmap.height, 1);
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  // Dessine sur un canvas
  const canvas = Object.assign(document.createElement("canvas"), { width: w, height: h });
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0, w, h);

  // Canvas → blob → File
  const blob: Blob = await new Promise((res) => canvas.toBlob((b) => res(b!), "image/png"));
  return new File([blob], file.name.replace(/\.[^.]+$/, ".png"), { type: "image/png" });
}

/** Redimensionne un base64 image ≤ 512 px et renvoie un nouveau base64. */
async function resizeBase64To512(b64: string): Promise<string> {
  const img = new Image();
  img.src = `data:image/*;base64,${b64}`;
  await new Promise((ok, err) => {
    img.onload = ok;
    img.onerror = err;
  });

  const scale = Math.min(512 / img.width, 512 / img.height, 1);
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);

  const canvas = Object.assign(document.createElement("canvas"), { width: w, height: h });
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, w, h);

  return canvas.toDataURL("image/png").split(",")[1]; // on retire le prefix data:
}

/** Récupère et parse la première sortie JSON d'une réponse OpenAI / v1/responses. */
function firstOutput<T = any>(res: any): T {
  const content = res.output?.[0]?.content?.[0];
  if (content?.type !== "output_text" || !content.text) {
    throw new Error("OpenAI: invalid response structure");
  }
  return JSON.parse(content.text) as T;
}

/* ---------------------------------------------------------- *
 *  API-key quick check                                       *
 * ---------------------------------------------------------- */
export async function testApiKey(apiKey: string): Promise<boolean> {
  try {
    const client = new OpenAI({ apiKey, dangerouslyAllowBrowser: true });
    const rsp = await client.models.list();
    return Array.isArray(rsp.data) && rsp.data.length > 0;
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------- *
 *  Packshot extraction                                       *
 * ---------------------------------------------------------- */
export async function extractPackshot(
  apiKey: string,
  imageFile: File,
  itemDescription: string,
  quality: 'low' | 'medium' | 'high' = 'low'
): Promise<string> {
  try {
    console.log('extractPackshot: Starting');
    const tokenService = TokenUsageService.getInstance();

    console.log('extractPackshot: Resizing image...');
    const resized = await resizeFileTo512(imageFile);
    console.log('extractPackshot: Image resized successfully');

    console.log('extractPackshot: Converting to file...');
    const fileForOpenAI = await toFile(resized, null, { type: "image/png" });
    console.log('extractPackshot: File converted for OpenAI');

    console.log('extractPackshot: Calling OpenAI via proxy...');
    const form = new FormData();
    form.append('model', 'gpt-image-1');
    form.append('image', fileForOpenAI as any);
    form.append('prompt', `Extract this product item (${itemDescription}) from the image and place it on a clean white background as a professional product photo (packshot). Keep only the item fully visible with perfect lighting and professional appearance. Remove all backgrounds, shadows, and other objects. Do not crop, cut, or clip any part of the item—ensure the entire product fits within the 1024×1024 frame. Center the product in the canvas and leave a uniform white margin (blank space) around all sides before generating.`);
    form.append('n', '1');
    form.append('size', '1024x1024');
    form.append('moderation', 'low');
    form.append('quality', quality);

    const res = await fetch('/openai/images/edits', {
      method: 'POST',
      body: form
    });
    if (!res.ok) {
      throw new Error(`OpenAI proxy error ${res.status}`);
    }
    const rsp = await res.json();

    console.log('extractPackshot: OpenAI API response received');
    console.log('extractPackshot: Response data length:', rsp.data?.length);
    console.log('extractPackshot: First item has b64_json:', !!rsp.data[0]?.b64_json);

    if (rsp.usage) {
      tokenService.addUsage({
        input_tokens_details: {
          text_tokens: rsp.usage.input_tokens_details?.text_tokens || 0,
          image_tokens: rsp.usage.input_tokens_details?.image_tokens || 0
        },
        output_tokens: rsp.usage.output_tokens || 0
      });
    }

    const result = rsp.data[0].b64_json ?? "";
    console.log('extractPackshot: Returning result, length:', result.length);
    return result;
  } catch (error) {
    console.error('extractPackshot: Error occurred:', error);
    console.error('extractPackshot: Error type:', error?.constructor?.name);
    console.error('extractPackshot: Error message:', error?.message);
    console.error('extractPackshot: Error stack:', error?.stack);
    throw error;
  }
}

/* ---------------------------------------------------------- *
 *  Metadata extraction                                       *
 * ---------------------------------------------------------- */
export async function analyzeItemMetadata(
  apiKey: string,
  imageBase64: string,
  categories: string[]
): Promise<{ name: string; category: string; description: string }> {  
  const client = new OpenAI({ apiKey, dangerouslyAllowBrowser: true });
  const resizedB64 = await resizeBase64To512(imageBase64);
  const tokenService = TokenUsageService.getInstance();

  const response = await client.responses.create({
    model: "gpt-4.1-nano",
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: "You are an assistant specialized in analyzing photos of clothing items. Extract the product name, its main category, and a brief description."
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `
              From this image, extract:
              1) A concise product name.
              2) The main category from: ${categories.join(', ')}.
              3) A brief one-sentence description.
              If several items appear, choose the most visually prominent.`
          },
          {
            type: "input_image",
            image_url: `data:image/png;base64,${resizedB64}`
          }
        ]
      }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "item_metadata",
        schema: {
          type: "object",
          required: ["name", "category", "description"],
          properties: {
            name: { type: "string" },
            category: {
              type: "string",
              enum: categories
            },
            description: { type: "string" },
          },
          additionalProperties: false
        },
        strict: true
      }
    },
    temperature: 0.03,
    max_output_tokens: 100,
    top_p: 0.67,
    store: false
  });

  if (response.usage) {
    tokenService.addUsage({
      input_tokens_details: {
        text_tokens: response.usage.input_tokens_details?.cached_tokens || 0,
        image_tokens: response.usage.input_tokens || 0
      },
      output_tokens: response.usage.output_tokens || 0
    });
  }

  return firstOutput(response);
}

/* ---------------------------------------------------------- *
 *  Photo-profil validation                                   *
 * ---------------------------------------------------------- */
export async function validateProfilePhoto(
  apiKey: string,
  imageBase64: string,
  photoType: "face" | "torso" | "full-body"
): Promise<{ isValid: boolean; reason: string }> {
  try {
    const client = new OpenAI({ apiKey, dangerouslyAllowBrowser: true });
    const resizedB64 = await resizeBase64To512(imageBase64);
    const tokenService = TokenUsageService.getInstance();

    const rsp = await client.responses.create({
      model: "gpt-4.1-nano",
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: "You are a photo validator for a virtual try-on system. You may validate a photo with a warning, use the reason to add your reserves on validating this photo but let the user add the photo for minor unconformities like a clotted background, a hand covering some of the face, a hat covering some of the face or an hairstyle covering the eyes, .. or similars. Leave reason empty if the photo is fully compliant."
            }
          ]
        },
        {
          role: "user",
          content: [
            { type: "input_text", text: getValidationRequirement(photoType) },
            { type: "input_image", image_url: `data:image/png;base64,${resizedB64}` }
          ]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "image_validation",
          schema: {
            type: "object",
            required: ["is_valid", "reason"],
            properties: {
              is_valid: { type: "boolean" },
              reason: { type: "string" }
            },
            additionalProperties: false
          },
          strict: true
        }
      },
      temperature: 0.03,
      max_output_tokens: 100,
      top_p: 0.67,
      store: false
    });

    if (rsp.usage) {
      tokenService.addUsage({
        input_tokens_details: {
          text_tokens: rsp.usage.input_tokens_details?.cached_tokens || 0,
          image_tokens: rsp.usage.input_tokens || 0
        },
        output_tokens: rsp.usage.output_tokens || 0
      });
    }

    const { is_valid, reason } = firstOutput<{ is_valid: boolean; reason: string }>(rsp);
    return { isValid: is_valid, reason };
  } catch (error: any) {
    console.error('validateProfilePhoto: error', error);
    const message: string =
      (error?.status === 401 || /401|invalid\s*api\s*key/i.test(error?.message || ''))
        ? 'Invalid OpenAI API key. Please re-enter it in Settings.'
        : (error?.status === 429 || /quota|rate limit/i.test(error?.message || ''))
          ? 'OpenAI rate limit or quota exceeded. Try again later.'
          : (/Failed to fetch|CORS|NetworkError|TypeError: fetch/i.test(error?.message || ''))
            ? 'Network/CORS error contacting OpenAI. If on localhost, the browser may be blocking the request.'
            : (error?.message || 'Unexpected error during validation.');
    throw new Error(message);
  }
}

/* ---------------------------------------------------------- *
 *  Virtual try-on generation                                 *
 * ---------------------------------------------------------- */
export async function generateComposition(
  apiKey: string,
  profilePhotoBase64: string,
  wardrobeItemsBase64: string[],
  wardrobeItemsDescriptions: string[],
  quality: 'low' | 'medium' | 'high' = 'low'
): Promise<string> {
  if (wardrobeItemsBase64.length !== wardrobeItemsDescriptions.length) {
    throw new Error("Mismatch between wardrobe images and descriptions.");
  }
  const tokenService = TokenUsageService.getInstance();

  // Pose + vêtements redimensionnés
  const allImages = await Promise.all([
    toFile(
      await fetch(`data:image/png;base64,${await resizeBase64To512(profilePhotoBase64)}`).then((r) => r.blob()),
      "pose.png",
      { type: "image/png" }
    ),
    ...wardrobeItemsBase64.map(async (b64, i) =>
      toFile(
        await fetch(`data:image/png;base64,${await resizeBase64To512(b64)}`).then((r) => r.blob()),
        `item-${i}.png`,
        { type: "image/png" }
      )
    )
  ]);

  const wardrobeText = wardrobeItemsDescriptions
    .map((d, i) => `- Item ${i + 1}: ${d}`)
    .join("\n");

  const prompt = `
    Create a realistic virtual try-on image showing this person wearing the provided clothing items. 
    
    Instructions:
    - Use the person from the first image (photo 0) as the base
    - Dress them with these clothing items: ${wardrobeText}
    - Make the clothing fit naturally on the person's body
    - Maintain the person's pose, face, and body proportions
    - Create realistic fabric textures and natural shadows
    - Use a clean white studio background
    - Ensure the person is fully visible from head to toe
    - Make it look like they are actually wearing the clothes
    
    The result should be a professional virtual try-on that looks realistic and natural.
  `.trim();

  // Build multipart/form-data for proxy call
  const form = new FormData();
  form.append('model', 'gpt-image-1');
  for (const img of allImages) {
    form.append('image', img as any);
  }
  form.append('prompt', prompt);
  form.append('size', '1024x1536');
  form.append('moderation', 'low');
  form.append('quality', quality);

  const res = await fetch('/openai/images/edits', {
    method: 'POST',
    body: form
  });
  if (!res.ok) {
    const errorText = await res.text();
    console.error('OpenAI API error:', res.status, errorText);
    throw new Error(`OpenAI API error ${res.status}: ${errorText}`);
  }
  const rsp = await res.json();

  if (rsp.usage) {
    tokenService.addUsage({
      input_tokens_details: {
        text_tokens: rsp.usage.input_tokens_details?.text_tokens || 0,
        image_tokens: rsp.usage.input_tokens_details?.image_tokens || 0
      },
      output_tokens: rsp.usage.output_tokens || 0
    });
  }

  if (!rsp.data || !rsp.data[0] || !rsp.data[0].b64_json) {
    console.error('Unexpected OpenAI response:', rsp);
    throw new Error('No image data received from OpenAI');
  }
  
  return rsp.data[0].b64_json;
}
 
/* ---------------------------------------------------------- *
 *  Validation-requirement helper                             *
 * ---------------------------------------------------------- */
function getValidationRequirement(photoType: "face" | "torso" | "full-body"): string {
   switch (photoType) {
      case 'face':
        return "The image must contain exactly one visible human face, seen from the front. The face should be clearly visible, well-lit, and take up most of the frame. No sunglasses, masks, or other face coverings should be present. Background should be simple and uncluttered.";
      case 'torso':
        return "The image must contain one person from shoulders to waist (torso shot). The person should be facing the camera, with arms visible. Clothing should be neutral and form-fitting enough to allow for virtual try-on. No bulky jackets or loose clothing that obscures body shape.";
      case 'full-body':
        return "The image must contain exactly one visible full human body, seen from the front. The full body from head to feet must be clearly visible. The person should be standing straight in a neutral pose. No other people should be visible in the image. Background should be simple and uncluttered.";
      default:
        return "The image must contain exactly one person with good lighting and a clear view of the subject.";
  }
}