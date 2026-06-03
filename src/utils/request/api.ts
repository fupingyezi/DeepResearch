interface ApiClientOptions {
  headers?: Record<string, string>;
  [key: string]: any;
}

interface RequestOptions extends RequestInit {
  headers?: Record<string, string>;
  isFormData?: boolean;
}

class ApiClient {
  private baseURL: string;
  private defaultOptions: ApiClientOptions;

  constructor(baseURL: string = '', defaultOptions: ApiClientOptions = {}) {
    this.baseURL = baseURL;
    this.defaultOptions = {
      // 同源携带 HttpOnly 会话 cookie，后端按用户隔离数据
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...defaultOptions.headers,
      },
      ...defaultOptions,
    };
  }

  // 通用请求
  async request(
    endpoint: string,
    options: RequestOptions = {},
    isFormData: boolean = false,
  ): Promise<any> {
    const url = `${this.baseURL}${endpoint}`;

    let config: RequestInit;

    if (isFormData) {
      // FormData，不设置 headers；但仍需携带会话 cookie
      config = {
        credentials: 'include',
        ...options,
      };
    } else {
      // 普通请求， 合并headers
      const headers = {
        ...this.defaultOptions.headers,
        ...options.headers,
      };

      config = {
        ...this.defaultOptions,
        ...options,
        headers,
      };
    }

    try {
      const response = await fetch(url, config);

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        return await response.json();
      }
      return await response.text();
    } catch (error) {
      console.error('API request failed:', error);
      throw error;
    }
  }

  // GET 请求
  async get(
    endpoint: string,
    params: Record<string, any> = {},
    options: RequestOptions = {},
  ): Promise<any> {
    const queryString = new URLSearchParams(params).toString();
    const url = queryString ? `${endpoint}?${queryString}` : endpoint;

    return this.request(url, {
      method: 'GET',
      ...options,
    });
  }

  // POST 请求
  async post(endpoint: string, data: any = {}, options: RequestOptions = {}): Promise<any> {
    const isFormData = data instanceof FormData;

    return this.request(
      endpoint,
      {
        method: 'POST',
        body: isFormData ? data : JSON.stringify(data),
        ...options,
      },
      isFormData,
    );
  }

  // PUT 请求
  async put(endpoint: string, data: any = {}, options: RequestOptions = {}): Promise<any> {
    return this.request(endpoint, {
      method: 'PUT',
      body: JSON.stringify(data),
      ...options,
    });
  }

  // DELETE 请求
  async delete(endpoint: string, options: RequestOptions = {}): Promise<any> {
    return this.request(endpoint, {
      method: 'DELETE',
      ...options,
    });
  }
}

const apiClient = new ApiClient('http://localhost:3000/api');
export { ApiClient };
export default apiClient;
