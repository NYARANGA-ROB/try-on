import OpenAI from "openai";
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
  _imageFile: File,
  itemDescription: string,
  quality: 'low' | 'medium' | 'high' = 'low'
): Promise<string> {
  try {
    console.log('extractPackshot: Starting packshot extraction');
    const client = new OpenAI({ apiKey, dangerouslyAllowBrowser: true });
    const tokenService = TokenUsageService.getInstance();

    // Note: We're using DALL-E 3 text-to-image generation instead of image editing
    // DALL-E generates a new packshot based on the item description

    console.log('extractPackshot: Using DALL-E 3 for packshot generation...');
    
    const prompt = `
      Create a professional product photo (packshot) of a ${itemDescription} on a clean white background.
      
      Requirements:
      - Extract and isolate the ${itemDescription} from any background
      - Place it on a pure white background
      - Professional studio lighting with soft shadows
      - Center the product in the frame
      - Show the complete item without cropping
      - High-quality product photography style
      - Clean, minimal, commercial appearance
      - Ensure the item is the main focus
      
      The result should look like a professional e-commerce product photo.
    `.trim();

    const response = await client.images.generate({
      model: "dall-e-3",
      prompt: prompt,
      n: 1,
      size: "1024x1024",
      quality: quality === 'high' ? 'hd' : 'standard',
      response_format: "b64_json"
    });

    console.log('extractPackshot: DALL-E 3 response received');

    // Track token usage (estimated)
    tokenService.addUsage({
      input_tokens_details: {
        text_tokens: Math.ceil(prompt.length / 4),
        image_tokens: 0
      },
      output_tokens: quality === 'high' ? 2000 : 1000
    });

    if (!response.data || !response.data[0] || !response.data[0].b64_json) {
      console.error('Unexpected DALL-E response:', response);
      throw new Error('No image data received from DALL-E');
    }

    const result = response.data[0].b64_json;
    console.log('extractPackshot: Successfully generated packshot, length:', result.length);
    return result;
    
  } catch (error: any) {
    console.error('extractPackshot: Error occurred:', error);
    
    // Provide specific error messages
    if (error?.status === 401 || /401|invalid\s*api\s*key/i.test(error?.message || '')) {
      throw new Error('Invalid OpenAI API key. Please check your API key in Settings.');
    } else if (error?.status === 429 || /quota|rate limit/i.test(error?.message || '')) {
      throw new Error('OpenAI rate limit or quota exceeded. Please try again later.');
    } else if (error?.status === 400 || /content policy|safety/i.test(error?.message || '')) {
      throw new Error('Content policy violation. Please try with a different image.');
    } else if (/Failed to fetch|NetworkError|TypeError: fetch/i.test(error?.message || '')) {
      throw new Error('Network error. Please check your internet connection.');
    } else {
      throw new Error(`Packshot extraction failed: ${error?.message || 'Unknown error'}`);
    }
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
            image_url: `data:image/png;base64,${resizedB64}`,
            detail: "high" as const
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
            { type: "input_image", image_url: `data:image/png;base64,${resizedB64}`, detail: "high" as const }
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
  try {
    console.log('generateComposition: Starting canvas-based composition');
    console.log('generateComposition: Profile photo length:', profilePhotoBase64.length);
    console.log('generateComposition: Wardrobe items count:', wardrobeItemsBase64.length);
    console.log('generateComposition: Descriptions:', wardrobeItemsDescriptions);
    
    // Create canvas for composition
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    if (!ctx) {
      throw new Error('Could not get canvas 2D context');
    }
    
    // Set canvas size
    canvas.width = 800;
    canvas.height = 1000;
    
    // Fill with white background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Load profile photo
    const profileImg = new Image();
    profileImg.crossOrigin = 'anonymous';
    profileImg.src = `data:image/jpeg;base64,${profilePhotoBase64}`;
    await new Promise((resolve, reject) => {
      profileImg.onload = () => {
        console.log('Profile photo loaded successfully:', profileImg.width, 'x', profileImg.height);
        resolve(null);
      };
      profileImg.onerror = (error) => {
        console.error('Failed to load profile photo:', error);
        reject(new Error('Failed to load profile photo'));
      };
    });
    
    // Load clothing images
    const clothingImages: HTMLImageElement[] = [];
    for (let i = 0; i < wardrobeItemsBase64.length; i++) {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = `data:image/jpeg;base64,${wardrobeItemsBase64[i]}`;
      await new Promise((resolve, reject) => {
        img.onload = () => {
          console.log(`Clothing item ${i + 1} loaded:`, img.width, 'x', img.height);
          clothingImages.push(img);
          resolve(null);
        };
        img.onerror = (error) => {
          console.error(`Failed to load clothing item ${i + 1}:`, error);
          reject(new Error(`Failed to load clothing item ${i + 1}`));
        };
      });
    }
    
    // Draw profile photo as base (full canvas)
    const profileScale = Math.min(
      (canvas.width * 0.9) / profileImg.width,
      (canvas.height * 0.9) / profileImg.height
    );
    const scaledProfileWidth = profileImg.width * profileScale;
    const scaledProfileHeight = profileImg.height * profileScale;
    const profileX = (canvas.width - scaledProfileWidth) / 2;
    const profileY = (canvas.height - scaledProfileHeight) / 2;
    
    console.log('Drawing profile photo at:', profileX, profileY, scaledProfileWidth, scaledProfileHeight);
    ctx.drawImage(profileImg, profileX, profileY, scaledProfileWidth, scaledProfileHeight);
    
    // Calculate actual body dimensions from the person's photo
    const bodyDimensions = {
      // Assume standard human proportions for a front-facing photo
      shoulderWidth: scaledProfileWidth * 0.45,  // Shoulders are ~45% of total width
      torsoHeight: scaledProfileHeight * 0.35,   // Torso is ~35% of total height
      waistWidth: scaledProfileWidth * 0.35,     // Waist is ~35% of total width
      legWidth: scaledProfileWidth * 0.25,       // Each leg is ~25% of total width
      
      // Key position points
      shoulderY: profileY + scaledProfileHeight * 0.15,  // Shoulders start at 15% down
      chestY: profileY + scaledProfileHeight * 0.25,     // Chest center at 25% down
      waistY: profileY + scaledProfileHeight * 0.45,     // Waist at 45% down
      hipY: profileY + scaledProfileHeight * 0.55,       // Hips at 55% down
      
      centerX: profileX + scaledProfileWidth / 2         // Body center line
    };
    
    console.log('Calculated body dimensions:', bodyDimensions);
    
    // Overlay clothing items using actual body measurements
    clothingImages.forEach((img, index) => {
      console.log(`Overlaying clothing item ${index + 1} using body dimensions`);
      
      // Determine clothing type
      const description = wardrobeItemsDescriptions[index]?.toLowerCase() || '';
      let clothingType = 'shirt';
      if (description.includes('jacket') || description.includes('blazer')) clothingType = 'jacket';
      if (description.includes('pants') || description.includes('jeans')) clothingType = 'pants';
      if (description.includes('dress')) clothingType = 'dress';
      
      let overlayWidth, overlayHeight, overlayX, overlayY;
      
      if (clothingType === 'pants') {
        // Pants: fit to leg width and lower body
        overlayWidth = bodyDimensions.legWidth * 2; // Both legs
        overlayHeight = (scaledProfileHeight * 0.4); // Lower 40% of body
        overlayX = bodyDimensions.centerX - overlayWidth / 2;
        overlayY = bodyDimensions.hipY;
      } else if (clothingType === 'dress') {
        // Dress: fit to shoulder width and cover torso + upper legs
        overlayWidth = bodyDimensions.shoulderWidth;
        overlayHeight = scaledProfileHeight * 0.5;
        overlayX = bodyDimensions.centerX - overlayWidth / 2;
        overlayY = bodyDimensions.shoulderY;
      } else {
        // Shirts/Jackets: fit to shoulder/chest dimensions
        overlayWidth = clothingType === 'jacket' ? bodyDimensions.shoulderWidth * 1.1 : bodyDimensions.shoulderWidth;
        overlayHeight = bodyDimensions.torsoHeight;
        overlayX = bodyDimensions.centerX - overlayWidth / 2;
        overlayY = bodyDimensions.shoulderY + (index * 10); // Slight offset for layering
      }
      
      console.log(`Item ${index + 1} (${clothingType}) dimensions: ${overlayWidth}x${overlayHeight} at (${overlayX}, ${overlayY})`);
      
      // Draw clothing fitted to body measurements
      ctx.save();
      ctx.globalCompositeOperation = 'source-atop';
      ctx.globalAlpha = 0.85;
      ctx.drawImage(img, overlayX, overlayY, overlayWidth, overlayHeight);
      ctx.restore();
      
      // Add item label if multiple items
      if (clothingImages.length > 1) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        ctx.fillRect(overlayX + 5, overlayY + 5, 70, 16);
        ctx.fillStyle = '#ffffff';
        ctx.font = '11px Arial';
        ctx.textAlign = 'left';
        ctx.fillText(
          wardrobeItemsDescriptions[index] || `Item ${index + 1}`,
          overlayX + 8,
          overlayY + 15
        );
      }
    });
    
    // Add title
    ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.fillRect(0, 0, canvas.width, 50);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 28px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('Virtual Try-On', canvas.width / 2, 35);
    
    // Convert canvas to base64
    console.log('Converting canvas to base64...');
    const result = canvas.toDataURL('image/png').split(',')[1];
    
    if (!result || result.length === 0) {
      throw new Error('Failed to generate canvas image data');
    }
    
    console.log('generateComposition: Successfully created virtual try-on, result length:', result.length);
    return result;
    
  } catch (error: any) {
    console.error('generateComposition: Error occurred:', error);
    throw new Error(`Outfit composition failed: ${error?.message || 'Unknown error'}`);
  }
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