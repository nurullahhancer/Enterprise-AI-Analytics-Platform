from typing import Any, Dict, List, Union
from pydantic import BaseModel

class Dataset(BaseModel):
    preview: Union[List[Dict[str, Any]], Dict[str, Any], Any]
