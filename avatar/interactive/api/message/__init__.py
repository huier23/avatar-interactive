import logging
import os
import json
import requests
from datetime import datetime, timedelta
import pyodbc

import azure.functions as func

search_endpoint = os.getenv("AZURE_SEARCH_ENDPOINT")
search_key = os.getenv("AZURE_SEARCH_API_KEY")
search_api_version = "2023-07-01-Preview"
# search_api_version = "2024-07-01"
search_index_name = os.getenv("AZURE_SEARCH_INDEX")

AOAI_endpoint = os.getenv("AZURE_OPENAI_ENDPOINT")
AOAI_key = os.getenv("AZURE_OPENAI_API_KEY")
AOAI_api_version = os.getenv("AZURE_OPENAI_API_VERSION")
embeddings_deployment = os.getenv("AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT")
chat_deployment = os.getenv("AZURE_OPENAI_CHAT_DEPLOYMENT")

# font color adjustments
blue, end_blue = "\033[36m", "\033[0m"
place_orders = False

functions = [
    {
        "name": "get_information",
        "description": "根據用戶問題查找展覽相關資訊。僅在對話上下文中沒有請求的信息時使用。",
        "parameters": {
            "type": "object",
            "properties": {
                "user_question": {
                    "type": "string",
                    "description": "用戶問題（例如: 請介紹展覽等）",
                },
            },
            "required": ["user_question"],
        },
    }
]


def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info("Python HTTP trigger function processed a request.")

    messages = json.loads(req.get_body())

    parsed_lang = messages[0].get("lang")

    response = chat_complete(messages, functions=functions, function_call="auto")

    products = []

    try:
        response_message = response["choices"][0]["message"]
    except:
        logging.info(response)

    # if the model wants to call a function
    if response_message.get("function_call"):
        # Call the function. The JSON response may not always be valid so make sure to handle errors
        function_name = response_message["function_call"]["name"]

        available_functions = {
            "get_information": get_information,
        }
        function_to_call = available_functions[function_name]

        function_args = json.loads(response_message["function_call"]["arguments"])
        function_response = function_to_call(**function_args)
        # print(function_name, function_args)

        # Add the assistant response and function response to the messages
        if parsed_lang == "zh-tw":
            messages.append(
                {
                    "role": "system",
                    "content": "1. 如果內容有中文字的時候, 請在回應的時候, 避免第一個字是英文, 必須要是中文字開頭\n" +
                            "2. 請在回應的時候, 請使用50個字以內回覆\n"
                }
            )
        if parsed_lang == "en-US":
            messages.append(
                {
                    "role": "system",
                    "content": "1. Please keep the response concise, within 50 words.\n"
                }
            )

        # Add the assistant response and function response to the messages
        messages.append(
            {
                "role": response_message["role"],
                "function_call": {
                    "name": function_name,
                    "arguments": response_message["function_call"]["arguments"],
                },
                "content": None,
            }
        )

        if function_to_call == get_information:
            product_info = json.loads(function_response)
            products = [display_product_info(product_info)]
            function_response = product_info["content"]
        messages.append(
            {
                "role": "function",
                "name": function_name,
                "content": function_response,
            }
        )
        response = chat_complete(messages, functions=functions, function_call="none")
        response_message = response["choices"][0]["message"]

    messages.append(
        {"role": response_message["role"], "content": response_message["content"]}
    )

    logging.info(json.dumps(response_message))

    response_object = {"messages": messages, "products": products}

    return func.HttpResponse(json.dumps(response_object), status_code=200)


def display_product_info(product_info, display_size=40):
    image_file = product_info["product_image_file"]

    # Use public blob storage URL to display image
    image_url = (
        "https://paytonavatarimage.blob.core.windows.net/liteon-images/" + image_file
    )
    print("image_url: ", image_url)
    return {"content": product_info["content"], "image_url": image_url}


def generate_embeddings(text):
    """Generate embeddings for an input string using embeddings API"""

    url = f"{AOAI_endpoint}/openai/deployments/{embeddings_deployment}/embeddings?api-version={AOAI_api_version}"

    headers = {
        "Content-Type": "application/json",
        "api-key": AOAI_key,
    }

    data = {"input": text}

    response = requests.post(url, headers=headers, data=json.dumps(data)).json()
    return response["data"][0]["embedding"]


def get_information(user_question, categories="*", top_k=1):
    """Vectorize user query to search Cognitive Search vector search on index_name. Optional filter on categories field."""

    url = f"{search_endpoint}/indexes/{search_index_name}/docs/search?api-version={search_api_version}"

    headers = {
        "Content-Type": "application/json",
        "api-key": f"{search_key}",
    }

    vector = generate_embeddings(user_question)

    data = {
        "vectors": [
            {"value": vector, "fields": "content_vector", "k": top_k},
        ],
        "select": "content, product_image_file",
    }

    results = requests.post(url, headers=headers, data=json.dumps(data))
    results_json = results.json()

    # Extracting the required fields from the results JSON
    product_data = results_json["value"][0]  # hard limit to top result for now

    response_data = {
        "content": product_data.get("content"),
        "product_image_file": product_data.get("product_image_file"),
    }
    return json.dumps(response_data)


def chat_complete(messages, functions, function_call="auto"):
    """Return assistant chat response based on user query. Assumes existing list of messages"""

    url = f"{AOAI_endpoint}/openai/deployments/{chat_deployment}/chat/completions?api-version={AOAI_api_version}"

    headers = {"Content-Type": "application/json", "api-key": AOAI_key}

    data = {
        "messages": messages,
        "functions": functions,
        "function_call": function_call,
        "temperature": 0,
    }

    logging.info(f"Received messages: {messages}")

    response = requests.post(url, headers=headers, data=json.dumps(data)).json()

    return response
