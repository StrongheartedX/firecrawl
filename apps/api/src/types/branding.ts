export interface BrandingProfile {
  color_scheme?: "light" | "dark";
  logo?: string | null;
  fonts?: Array<{
    family: string;
    [key: string]: unknown;
  }>;
  colors?: {
    primary?: string;
    secondary?: string;
    accent?: string;
    background?: string;
    text_primary?: string;
    text_secondary?: string;
    link?: string;
    success?: string;
    warning?: string;
    error?: string;
    [key: string]: string | undefined;
  };
  typography?: {
    font_families?: {
      primary?: string;
      heading?: string;
      code?: string;
      [key: string]: string | undefined;
    };
    font_stacks?: {
      primary?: string[];
      heading?: string[];
      body?: string[];
      paragraph?: string[];
      [key: string]: string[] | undefined;
    };
    font_sizes?: {
      h1?: string;
      h2?: string;
      h3?: string;
      body?: string;
      small?: string;
      [key: string]: string | undefined;
    };
    line_heights?: {
      heading?: number;
      body?: number;
      [key: string]: number | undefined;
    };
    font_weights?: {
      light?: number;
      regular?: number;
      medium?: number;
      bold?: number;
      [key: string]: number | undefined;
    };
  };
  spacing?: {
    base_unit?: number;
    padding?: Record<string, number>;
    margins?: Record<string, number>;
    grid_gutter?: number;
    border_radius?: string;
    [key: string]: number | string | Record<string, number> | undefined;
  };
  components?: {
    button_primary?: {
      background?: string;
      text_color?: string;
      border_color?: string;
      border_radius?: string;
      hover_background?: string;
      hover_text_color?: string;
      hover_border_color?: string;
      [key: string]: string | undefined;
    };
    button_secondary?: {
      background?: string;
      text_color?: string;
      border_color?: string;
      border_radius?: string;
      hover_background?: string;
      hover_text_color?: string;
      hover_border_color?: string;
      [key: string]: string | undefined;
    };
    input?: {
      border_color?: string;
      focus_border_color?: string;
      border_radius?: string;
      [key: string]: string | undefined;
    };
    [key: string]: unknown;
  };
  icons?: {
    style?: string;
    primary_color?: string;
    [key: string]: string | undefined;
  };
  images?: {
    logo?: string | null;
    favicon?: string | null;
    og_image?: string | null;
    [key: string]: string | null | undefined;
  };
  animations?: {
    transition_duration?: string;
    easing?: string;
    [key: string]: string | undefined;
  };
  layout?: {
    grid?: {
      columns?: number;
      max_width?: string;
      [key: string]: number | string | undefined;
    };
    header_height?: string;
    footer_height?: string;
    [key: string]:
      | number
      | string
      | Record<string, number | string | undefined>
      | undefined;
  };
  tone?: {
    voice?: string;
    emoji_usage?: string;
    [key: string]: string | undefined;
  };
  // LLM-enhanced fields
  personality?: {
    tone:
      | "professional"
      | "playful"
      | "modern"
      | "traditional"
      | "minimalist"
      | "bold";
    energy: "low" | "medium" | "high";
    target_audience: string;
  };
  design_system?: {
    framework:
      | "tailwind"
      | "bootstrap"
      | "material"
      | "chakra"
      | "custom"
      | "unknown";
    component_library?: string;
  };
  confidence?: {
    buttons: number;
    colors: number;
    overall: number;
  };
  [key: string]: unknown;
}
