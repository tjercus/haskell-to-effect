main :: IO ()
main = do
  (a, b) <- return (1, "x")
  putStrLn (show a ++ b)
  Just c <- return (Nothing :: Maybe Int)
  print c
